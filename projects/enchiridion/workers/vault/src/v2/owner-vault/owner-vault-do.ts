import { DurableObject } from "cloudflare:workers";
/** @enchiridion/effect-module */
import {
  type CanonicalJSON,
  canonicalJSONStringify,
  decodeDeviceChallengeRequest,
  decodeDeviceChallengeResponse,
  decodeDeviceRegisterRequest,
  decodeDeviceRegisterResponse,
  decodeMutationRequest,
  mutationCommandSHA256,
  parseJSONWithoutDuplicateMembers,
  protocolVersion,
  sha256Hex,
  signedDeviceRequestSigningPayload,
  syncChangeSigningPayload,
  type DeviceChallengeRequest,
  type DeviceRegisterRequest,
  type MutationRequest,
} from "@enchiridion/protocol";
import {
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  OwnerVaultDirectoryControlResource,
  maximumOwnerVaultSocketAdmissionSerializedHeaderBytes,
  ownerVaultSocketAdmissionHeader,
  ownerVaultSocketAdmissionPath,
  type OwnerVaultSocketAdmissionClaims,
  type OwnerVaultSocketAdmissionRequestBinding,
  type SignedCapability,
  type SignedOwnerVaultDirectoryControl,
  makeDurableObjectBoundary,
  makeP256Crypto,
  P256Crypto,
  ownerVaultCredentialFencePath,
  ownerVaultPrivateInitializePath,
  ownerVaultRestorePath,
  ownerVaultSnapshotPath,
  readBoundedRequestBody,
  type CapabilityClaims,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  type OwnerVaultFloorSyncAck,
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationAck,
  type OwnerVaultInitializationCommand,
  ownerVaultFloorSyncPath,
  ownerVaultInitializationPath,
  validOwnerVaultFloorSyncCommand,
  validOwnerVaultInitializationCommand,
} from "../directory/lifecycle";
import type {
  OwnerVaultDirectoryControlFactory,
  OwnerVaultSocketAdmissionFactory,
} from "../entry/composition";
import type { OwnerVaultProductionAuthority } from "../entry/owner-vault-production";
import {
  InternalCapabilityFactory,
  type DirectoryControlCapabilityFactory,
  type InternalCapabilityFactory as InternalCapabilityFactoryType,
} from "../foundation/crypto";
import { makeDeviceService } from "../devices/service";
import { decodeOwnerVaultClientFrame } from "../sync/service";
import {
  DeviceRegistryRepository,
  DeviceService,
  DeviceServiceError,
  ExistingDeviceRecoveryRebinder,
  type DeviceRecord,
  type DeviceRegistryRepository as DeviceRegistryRepositoryType,
  type DeviceService as DeviceServiceType,
} from "../devices/types";
import { createOwnerVaultBackup, restoreOwnerVaultBackup } from "./backup";
import {
  canonicalSignedManifestBytes,
  ownerVaultBackupControlDigest,
  validOwnerVaultBackupControlDigest,
} from "./backup-canonical";
import { OwnerVaultBackupError } from "./backup-types";
import {
  makeOwnerVaultDomainProvider,
  ownerVaultMaximumSessions,
  OwnerVaultDomainError,
  type OwnerVaultDevice,
  type OwnerVaultCapabilityReceiptInput,
  type OwnerVaultDomainProvider,
} from "./domains";
import { makeOwnerVaultProviderGraph } from "./provider-graph";
import { ownerVaultOpaqueMutationFingerprint } from "./opaque-mutation-fingerprint";
import {
  type OwnerVaultStorageTransactionFailure,
  type OwnerVaultStorageRepositoryError,
  type OwnerVaultStorageRepository,
  makeDurableObjectOwnerVaultStorageRepository,
} from "./repository";

const maximumBodyBytes = 16_384;
const controlMaximumBodyBytes = 32_768;
const emptyBodySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const socketAttachmentMaximumBytes = 1_024;
const socketMaximumFramesPerMinute = 120;
/** Internal-only P06 dispatch targets. Their capability binding includes these
 * exact paths and the canonical command body; no public route reaches them. */
export const ownerVaultDeviceChallengePath = "/__v2/internal/owner-vault/devices/challenge";
export const ownerVaultDeviceCompletePath = "/__v2/internal/owner-vault/devices/complete";
export const ownerVaultOpaqueAppendPath = "/__v2/internal/owner-vault/append";
const ownerVaultAppendMaximumBodyBytes = 1_500_000;
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const now = (): number => Math.floor(Date.now() / 1_000);
const response = (body: Readonly<Record<string, unknown>>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const bodyHash = (command: Readonly<Record<string, unknown>>): string =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(command)));
/** Canonical non-secret proof persisted with a claimed capability receipt. */
const canonicalCapabilityClaims = (claims: Readonly<Record<string, unknown>>): string =>
  canonicalJSONStringify(claims as CanonicalJSON);
const capabilityClaimsFingerprint = (claims: Readonly<Record<string, unknown>>): string =>
  sha256Hex(new TextEncoder().encode(canonicalCapabilityClaims(claims)));
const capabilityTokenFingerprint = (capability: SignedCapability): string =>
  sha256Hex(new TextEncoder().encode(capability.value));
const capabilityReceiptInput = (
  claims: Readonly<{ jti: string; expiresAt: number }>,
  capability: Readonly<{ value: string }>,
  resource: string,
  operationID: string,
  nowSeconds: number,
): OwnerVaultCapabilityReceiptInput => ({
  jti: claims.jti,
  resource,
  operationID,
  nowSeconds,
  expiresAtSeconds: claims.expiresAt,
  claims: canonicalCapabilityClaims(claims as unknown as Readonly<Record<string, unknown>>),
  claimsFingerprint: capabilityClaimsFingerprint(
    claims as unknown as Readonly<Record<string, unknown>>,
  ),
  tokenFingerprint: capabilityTokenFingerprint(capability),
});
const durableReceipt = (kind: string, operationID: string, digest: string): string =>
  sha256Hex(new TextEncoder().encode(`${kind}\u0000${operationID}\u0000${digest}`));
const privateRestoreLink = (
  command: Pick<
    OwnerVaultPrivateInitializeCommand | OwnerVaultRestoreCommand,
    | "sourceGeneration"
    | "targetGeneration"
    | "allocationID"
    | "initID"
    | "backupID"
    | "manifestDigest"
  >,
): string =>
  sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        sourceGeneration: command.sourceGeneration,
        targetGeneration: command.targetGeneration,
        allocationID: command.allocationID,
        initID: command.initID,
        backupID: command.backupID,
        manifestDigest: command.manifestDigest,
      }),
    ),
  );

interface SocketCapabilityHint {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly deviceID: string;
  readonly sessionID: string;
  readonly operationID: string;
  readonly upgradeNonce: string;
}
interface SocketAdmissionRecord {
  readonly phase: "PREPARED" | "ACCEPTED" | "EXPIRED" | "CLOSED";
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly namespaceState: "PRIVATE" | "ACTIVE";
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly fingerprint: string;
  readonly jti: string;
  readonly operationID: string;
  readonly deviceID: string;
  readonly sessionID: string;
  readonly upgradeNonce: string;
  readonly bindingNonce: string;
  readonly challenge: {
    readonly challengeID: string;
    readonly challengeBase64: string;
    readonly challengeAudience: "owner-vault-socket";
  };
  readonly createdAtMilliseconds: number;
  readonly acceptedAtMilliseconds: number;
  readonly issuedAtSeconds: number;
  readonly expiresAtSeconds: number;
  readonly expiresAtMilliseconds: number;
  readonly socketGeneration: number;
  readonly quotaReserved: boolean;
}
interface SocketJtiRecord {
  readonly operationID: string;
  readonly fingerprint: string;
  readonly expiresAtMilliseconds: number;
}
interface SocketAttachment {
  readonly version: 1;
  readonly operationID: string;
  /** Durable replay-index identifier only; never a capability bearer. */
  readonly jti: string;
  readonly sessionID: string;
  readonly deviceID: string;
  readonly bindingNonce: string;
  readonly socketGeneration: number;
  readonly expiresAtMilliseconds: number;
}
const base64urlBytes = (value: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (entry) => entry.charCodeAt(0));
    return bytes.byteLength > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};
const base64Bytes = (value: string): Uint8Array | undefined => {
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) return undefined;
    return Uint8Array.from(binary, (entry) => entry.charCodeAt(0));
  } catch {
    return undefined;
  }
};
const socketHint = (capability: string): SocketCapabilityHint | undefined => {
  const parts = capability.split(".");
  if (parts.length !== 3 || parts[0] !== "ovsa1" || parts[1] === undefined) return undefined;
  const bytes = base64urlBytes(parts[1]);
  if (bytes === undefined) return undefined;
  try {
    const payload = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      payload === undefined ||
      typeof payload.ownerID !== "string" ||
      typeof payload.vaultID !== "string" ||
      typeof payload.deviceID !== "string" ||
      typeof payload.sessionID !== "string" ||
      typeof payload.operationID !== "string" ||
      typeof payload.upgradeNonce !== "string" ||
      !opaqueID.test(payload.ownerID) ||
      !opaqueID.test(payload.vaultID) ||
      payload.ownerID === payload.vaultID ||
      !opaqueID.test(payload.deviceID) ||
      !opaqueID.test(payload.sessionID) ||
      !opaqueOperationID.test(payload.operationID) ||
      !/^[A-Za-z0-9_-]{22,128}$/u.test(payload.upgradeNonce)
    )
      return undefined;
    return {
      ownerID: payload.ownerID,
      vaultID: payload.vaultID,
      deviceID: payload.deviceID,
      sessionID: payload.sessionID,
      operationID: payload.operationID,
      upgradeNonce: payload.upgradeNonce,
    };
  } catch {
    return undefined;
  }
};
const socketFingerprint = (capability: string): string =>
  sha256Hex(new TextEncoder().encode(capability));
const socketIdentifier = /^[A-Za-z0-9_-]{16,64}$/u;
const validSocketAttachment = (value: unknown): value is SocketAttachment => {
  const source = record(value);
  return (
    source !== undefined &&
    exact(source, [
      "version",
      "operationID",
      "jti",
      "sessionID",
      "deviceID",
      "bindingNonce",
      "socketGeneration",
      "expiresAtMilliseconds",
    ]) &&
    source.version === 1 &&
    typeof source.operationID === "string" &&
    socketIdentifier.test(source.operationID) &&
    typeof source.jti === "string" &&
    socketIdentifier.test(source.jti) &&
    typeof source.sessionID === "string" &&
    opaqueID.test(source.sessionID) &&
    typeof source.deviceID === "string" &&
    opaqueID.test(source.deviceID) &&
    typeof source.bindingNonce === "string" &&
    /^[A-Za-z0-9_-]{22}$/u.test(source.bindingNonce) &&
    positive(source.socketGeneration) &&
    typeof source.expiresAtMilliseconds === "number" &&
    Number.isSafeInteger(source.expiresAtMilliseconds) &&
    source.expiresAtMilliseconds > 0
  );
};
const socketRecord = (value: unknown): SocketAdmissionRecord | undefined => {
  const source = record(value);
  const challenge = source === undefined ? undefined : record(source.challenge);
  return source !== undefined &&
    challenge !== undefined &&
    exact(source, [
      "acceptedAtMilliseconds",
      "bindingNonce",
      "challenge",
      "controlEpoch",
      "createdAtMilliseconds",
      "credentialEpoch",
      "deviceID",
      "expiresAtMilliseconds",
      "expiresAtSeconds",
      "fingerprint",
      "generationEpoch",
      "issuedAtSeconds",
      "jti",
      "namespaceState",
      "operationID",
      "ownerID",
      "phase",
      "quotaReserved",
      "routingEpoch",
      "securityFloor",
      "sessionID",
      "socketGeneration",
      "upgradeNonce",
      "vaultID",
    ]) &&
    (source.phase === "PREPARED" ||
      source.phase === "ACCEPTED" ||
      source.phase === "EXPIRED" ||
      source.phase === "CLOSED") &&
    typeof source.fingerprint === "string" &&
    hexDigest.test(source.fingerprint) &&
    typeof source.jti === "string" &&
    socketIdentifier.test(source.jti) &&
    typeof source.operationID === "string" &&
    socketIdentifier.test(source.operationID) &&
    typeof source.ownerID === "string" &&
    opaqueID.test(source.ownerID) &&
    typeof source.vaultID === "string" &&
    opaqueID.test(source.vaultID) &&
    source.ownerID !== source.vaultID &&
    positive(source.generationEpoch) &&
    (source.namespaceState === "PRIVATE" || source.namespaceState === "ACTIVE") &&
    positive(source.routingEpoch) &&
    positive(source.credentialEpoch) &&
    positive(source.controlEpoch) &&
    positive(source.securityFloor) &&
    typeof source.deviceID === "string" &&
    opaqueID.test(source.deviceID) &&
    typeof source.sessionID === "string" &&
    opaqueID.test(source.sessionID) &&
    typeof source.bindingNonce === "string" &&
    /^[A-Za-z0-9_-]{22,128}$/u.test(source.bindingNonce) &&
    typeof source.upgradeNonce === "string" &&
    /^[A-Za-z0-9_-]{22,128}$/u.test(source.upgradeNonce) &&
    typeof source.createdAtMilliseconds === "number" &&
    Number.isSafeInteger(source.createdAtMilliseconds) &&
    source.createdAtMilliseconds >= 0 &&
    typeof source.acceptedAtMilliseconds === "number" &&
    Number.isSafeInteger(source.acceptedAtMilliseconds) &&
    (source.phase === "PREPARED" || source.phase === "EXPIRED"
      ? source.acceptedAtMilliseconds === 0
      : source.acceptedAtMilliseconds >= source.createdAtMilliseconds) &&
    typeof source.issuedAtSeconds === "number" &&
    Number.isSafeInteger(source.issuedAtSeconds) &&
    source.issuedAtSeconds >= 0 &&
    typeof source.expiresAtSeconds === "number" &&
    Number.isSafeInteger(source.expiresAtSeconds) &&
    source.expiresAtSeconds > source.issuedAtSeconds &&
    typeof source.expiresAtMilliseconds === "number" &&
    Number.isSafeInteger(source.expiresAtMilliseconds) &&
    source.expiresAtMilliseconds === source.expiresAtSeconds * 1_000 &&
    source.expiresAtMilliseconds > source.createdAtMilliseconds &&
    positive(source.socketGeneration) &&
    typeof source.quotaReserved === "boolean" &&
    exact(challenge, ["challengeID", "challengeBase64", "challengeAudience"]) &&
    typeof challenge.challengeID === "string" &&
    opaqueID.test(challenge.challengeID) &&
    typeof challenge.challengeBase64 === "string" &&
    /^[A-Za-z0-9_-]{22}$/u.test(challenge.challengeBase64) &&
    challenge.challengeAudience === "owner-vault-socket"
    ? {
        phase: source.phase,
        ownerID: source.ownerID,
        vaultID: source.vaultID,
        generationEpoch: source.generationEpoch,
        namespaceState: source.namespaceState,
        routingEpoch: source.routingEpoch,
        credentialEpoch: source.credentialEpoch,
        controlEpoch: source.controlEpoch,
        securityFloor: source.securityFloor,
        fingerprint: source.fingerprint,
        jti: source.jti,
        operationID: source.operationID,
        deviceID: source.deviceID,
        sessionID: source.sessionID,
        upgradeNonce: source.upgradeNonce,
        bindingNonce: source.bindingNonce,
        challenge: {
          challengeID: challenge.challengeID,
          challengeBase64: challenge.challengeBase64,
          challengeAudience: "owner-vault-socket",
        },
        createdAtMilliseconds: source.createdAtMilliseconds,
        acceptedAtMilliseconds: source.acceptedAtMilliseconds,
        issuedAtSeconds: source.issuedAtSeconds,
        expiresAtSeconds: source.expiresAtSeconds,
        expiresAtMilliseconds: source.expiresAtMilliseconds,
        socketGeneration: source.socketGeneration,
        quotaReserved: source.quotaReserved,
      }
    : undefined;
};
const socketJtiRecord = (value: unknown): SocketJtiRecord | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, ["expiresAtMilliseconds", "fingerprint", "operationID"]) &&
    typeof source.operationID === "string" &&
    socketIdentifier.test(source.operationID) &&
    typeof source.fingerprint === "string" &&
    hexDigest.test(source.fingerprint) &&
    typeof source.expiresAtMilliseconds === "number" &&
    Number.isSafeInteger(source.expiresAtMilliseconds) &&
    source.expiresAtMilliseconds > 0
    ? {
        operationID: source.operationID,
        fingerprint: source.fingerprint,
        expiresAtMilliseconds: source.expiresAtMilliseconds,
      }
    : undefined;
};
interface SocketDeviceRecord {
  readonly deviceID: string;
  readonly publicKeySPKI: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly securityFloor: number;
  readonly revoked: boolean;
}
const socketDeviceRecord = (value: unknown): SocketDeviceRecord | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, [
      "authEpoch",
      "credentialEpoch",
      "deviceID",
      "publicKeySPKI",
      "revoked",
      "securityFloor",
    ]) &&
    typeof source.deviceID === "string" &&
    opaqueID.test(source.deviceID) &&
    positive(source.authEpoch) &&
    positive(source.credentialEpoch) &&
    nonNegative(source.securityFloor) &&
    typeof source.publicKeySPKI === "string" &&
    source.publicKeySPKI.length <= 8_192 &&
    typeof source.revoked === "boolean"
    ? {
        deviceID: source.deviceID,
        publicKeySPKI: source.publicKeySPKI,
        authEpoch: source.authEpoch,
        credentialEpoch: source.credentialEpoch,
        securityFloor: source.securityFloor,
        revoked: source.revoked,
      }
    : undefined;
};
interface SocketSessionRecord {
  readonly sessionID: string;
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly securityFloor: number;
  readonly assertionExpiresAtMilliseconds: number;
  readonly resumeTokenHash: string;
}
const socketSessionRecord = (value: unknown): SocketSessionRecord | undefined => {
  const source = record(value);
  return source !== undefined &&
    exact(source, [
      "assertionExpiresAtMilliseconds",
      "authEpoch",
      "credentialEpoch",
      "deviceID",
      "resumeTokenHash",
      "securityFloor",
      "sessionID",
    ]) &&
    typeof source.sessionID === "string" &&
    opaqueID.test(source.sessionID) &&
    typeof source.deviceID === "string" &&
    opaqueID.test(source.deviceID) &&
    positive(source.authEpoch) &&
    positive(source.credentialEpoch) &&
    nonNegative(source.securityFloor) &&
    typeof source.assertionExpiresAtMilliseconds === "number" &&
    Number.isSafeInteger(source.assertionExpiresAtMilliseconds) &&
    source.assertionExpiresAtMilliseconds > 0 &&
    typeof source.resumeTokenHash === "string" &&
    hexDigest.test(source.resumeTokenHash)
    ? {
        sessionID: source.sessionID,
        deviceID: source.deviceID,
        authEpoch: source.authEpoch,
        credentialEpoch: source.credentialEpoch,
        securityFloor: source.securityFloor,
        assertionExpiresAtMilliseconds: source.assertionExpiresAtMilliseconds,
        resumeTokenHash: source.resumeTokenHash,
      }
    : undefined;
};
const forbiddenSocketCredential = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "cookie" ||
    normalized === "proxy-authorization" ||
    normalized.startsWith("cf-access-")
  );
};
interface SocketAdmissionCounts {
  readonly activeChallenges: number;
  readonly activeDevices: number;
  readonly activeSessions: number;
  readonly capabilityReceipts: number;
  readonly stopped: boolean;
  readonly pendingSocketAdmissions: number;
  readonly activeSocketAdmissions: number;
  readonly preparedSocketOperationIDs: readonly string[];
  readonly socketReplayJTIs: readonly string[];
}
const socketAdmissionCounts = (value: unknown): SocketAdmissionCounts | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    !(
      exact(source, [
        "activeChallenges",
        "activeDevices",
        "activeSessions",
        "capabilityReceipts",
      ]) ||
      exact(source, [
        "activeChallenges",
        "activeDevices",
        "activeSessions",
        "capabilityReceipts",
        "stopped",
      ]) ||
      exact(source, [
        "activeChallenges",
        "activeDevices",
        "activeSessions",
        "capabilityReceipts",
        "stopped",
        "pendingSocketAdmissions",
        "activeSocketAdmissions",
      ]) ||
      exact(source, [
        "activeChallenges",
        "activeDevices",
        "activeSessions",
        "capabilityReceipts",
        "stopped",
        "pendingSocketAdmissions",
        "activeSocketAdmissions",
        "preparedSocketOperationIDs",
        "socketReplayJTIs",
      ])
    )
  )
    return undefined;
  const counts = [
    source.activeChallenges,
    source.activeDevices,
    source.activeSessions,
    source.capabilityReceipts,
    source.pendingSocketAdmissions ?? 0,
    source.activeSocketAdmissions ?? 0,
  ];
  const prepared = source.preparedSocketOperationIDs ?? [];
  const replayJTIs = source.socketReplayJTIs ?? [];
  return counts.every(nonNegative) &&
    (source.stopped === undefined || typeof source.stopped === "boolean") &&
    Array.isArray(prepared) &&
    prepared.length <= ownerVaultMaximumSessions &&
    prepared.every(
      (operationID) => typeof operationID === "string" && socketIdentifier.test(operationID),
    ) &&
    new Set(prepared).size === prepared.length &&
    Array.isArray(replayJTIs) &&
    replayJTIs.length <= ownerVaultMaximumSessions &&
    replayJTIs.every((jti) => typeof jti === "string" && socketIdentifier.test(jti)) &&
    new Set(replayJTIs).size === replayJTIs.length
    ? {
        activeChallenges: source.activeChallenges as number,
        activeDevices: source.activeDevices as number,
        activeSessions: source.activeSessions as number,
        capabilityReceipts: source.capabilityReceipts as number,
        stopped: source.stopped === true,
        pendingSocketAdmissions: (source.pendingSocketAdmissions ?? 0) as number,
        activeSocketAdmissions: (source.activeSocketAdmissions ?? 0) as number,
        preparedSocketOperationIDs: prepared as readonly string[],
        socketReplayJTIs: replayJTIs as readonly string[],
      }
    : undefined;
};
interface SocketAuthority {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly namespaceState: "PRIVATE" | "ACTIVE";
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly admission: SocketAdmissionCounts;
}
type SocketStorageFailure = OwnerVaultStorageTransactionFailure | OwnerVaultStorageRepositoryError;

const deviceError = (reason: DeviceServiceError["reason"]): DeviceServiceError =>
  new DeviceServiceError({ reason });
const deviceErrorFromDomain = (error: OwnerVaultDomainError): DeviceServiceError => {
  switch (error.reason) {
    case "challenge_consumed":
    case "challenge_expired":
    case "challenge_not_found":
    case "quota_exceeded":
      return deviceError(error.reason === "quota_exceeded" ? "challenge_quota" : error.reason);
    case "replay_conflict":
      return deviceError("idempotency_conflict");
    case "authorization_denied":
      return deviceError("device_not_found");
    case "identity_conflict":
    case "state_corrupt":
      return deviceError("state_conflict");
    default:
      return deviceError("temporarily_unavailable");
  }
};
const deviceRecordFromDomain = (
  root: Pick<SocketAuthority, "ownerID" | "vaultID" | "generationEpoch">,
  device: OwnerVaultDevice,
): DeviceRecord => ({
  ownerID: root.ownerID,
  vaultID: root.vaultID,
  generationEpoch: root.generationEpoch,
  ...device,
});
const sameDeviceRoot = (
  root: Pick<SocketAuthority, "ownerID" | "vaultID" | "generationEpoch">,
  device: Pick<DeviceRecord, "ownerID" | "vaultID" | "generationEpoch">,
): boolean =>
  device.ownerID === root.ownerID &&
  device.vaultID === root.vaultID &&
  device.generationEpoch === root.generationEpoch;

interface ControlEnvelope<C> {
  readonly capability: SignedCapability;
  readonly command: C;
}
interface OwnerVaultControlEnvelope<C> {
  readonly capability: SignedOwnerVaultDirectoryControl;
  readonly command: C;
}
const decodeEnvelope = <C>(
  bytes: Uint8Array,
  validCommand: (value: C) => boolean,
): ControlEnvelope<C> | undefined => {
  try {
    const root = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      root === undefined ||
      !exact(root, ["capability", "command"]) ||
      typeof root.capability !== "string"
    )
      return undefined;
    const command = record(root.command) as C | undefined;
    return command !== undefined && validCommand(command)
      ? { capability: { value: root.capability }, command }
      : undefined;
  } catch {
    return undefined;
  }
};
const decodeOwnerVaultControlEnvelope = <C extends Readonly<Record<string, unknown>>>(
  bytes: Uint8Array,
  validCommand: (value: Readonly<Record<string, unknown>>) => value is C,
): OwnerVaultControlEnvelope<C> | undefined => {
  try {
    const root = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      root === undefined ||
      !exact(root, ["capability", "command"]) ||
      typeof root.capability !== "string"
    )
      return undefined;
    const command = record(root.command);
    return command !== undefined && validCommand(command)
      ? { capability: { value: root.capability }, command }
      : undefined;
  } catch {
    return undefined;
  }
};
/**
 * The user capability binds the decoded command rather than this outer wire
 * envelope. Binding the envelope would create a hash cycle because the
 * capability itself lives in that envelope.
 */
const decodeOwnerVaultUserEnvelope = <C>(
  bytes: Uint8Array,
  decodeCommand: (value: unknown) => C,
): ControlEnvelope<C> | undefined => {
  try {
    const root = record(
      parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (
      root === undefined ||
      !exact(root, ["capability", "command"]) ||
      typeof root.capability !== "string"
    )
      return undefined;
    return { capability: { value: root.capability }, command: decodeCommand(root.command) };
  } catch {
    return undefined;
  }
};
const commandIdentity = (
  command: OwnerVaultInitializationCommand | OwnerVaultFloorSyncCommand,
) => ({
  ownerID: command.ownerID,
  vaultID: command.vaultID,
  generationEpoch: command.generationEpoch,
  namespaceState: "PRIVATE" as const,
});
const initPayload = (command: OwnerVaultInitializationCommand, receipt: string) => ({
  initDigest: command.initDigest,
  credentialEpoch: command.credentialEpoch,
  routingEpoch: command.routingEpoch,
  controlEpoch: command.controlEpoch,
  durableReceipt: receipt,
});
const floorPayload = (command: OwnerVaultFloorSyncCommand, receipt: string) => ({
  floorSyncDigest: command.floorSyncDigest,
  credentialEpoch: command.credentialEpoch,
  routingEpoch: command.routingEpoch,
  controlEpoch: command.controlEpoch,
  durableReceipt: receipt,
});
const samePayload = (
  value: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean =>
  exact(value, Object.keys(expected)) &&
  Object.entries(expected).every(([key, item]) => value[key] === item);
const rejectControl = <A = never>(): Effect.Effect<A, OwnerVaultStorageTransactionFailure> =>
  Effect.fail({ _tag: "OwnerVaultDomainTransactionError", reason: "replay_conflict" });
const samePrivateIdentity = (
  payload: Readonly<Record<string, unknown>>,
  command: OwnerVaultFloorSyncCommand,
): boolean =>
  exact(payload, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) &&
  payload.ownerID === command.ownerID &&
  payload.vaultID === command.vaultID &&
  payload.generationEpoch === command.generationEpoch &&
  payload.namespaceState === "PRIVATE";

const opaqueID = /^[A-Za-z0-9._~-]{1,128}$/u;
const opaqueOperationID = /^[A-Za-z0-9_-]{16,128}$/u;
const hexDigest = /^[a-f0-9]{64}$/u;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const controlCommonKeys = [
  "ownerID",
  "vaultID",
  "generationEpoch",
  "routingEpoch",
  "credentialEpoch",
  "controlEpoch",
  "securityFloor",
  "operationID",
  "jti",
] as const;
interface OwnerVaultControlCommand extends Readonly<Record<string, unknown>> {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  readonly controlEpoch: number;
  readonly securityFloor: number;
  readonly operationID: string;
  readonly jti: string;
}
interface OwnerVaultPrivateInitializeCommand extends OwnerVaultControlCommand {
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly allocationID: string;
  readonly initID: string;
  readonly backupID: string;
  readonly manifestDigest: string;
}
interface OwnerVaultCredentialFenceCommand extends OwnerVaultControlCommand {
  readonly expectedCredentialEpoch: number;
  readonly expectedRoutingEpoch: number;
  readonly expectedControlEpoch: number;
  readonly expectedSecurityFloor: number;
  readonly raisedCredentialEpoch: number;
  readonly raisedRoutingEpoch: number;
}
interface OwnerVaultSnapshotCommand extends OwnerVaultControlCommand {
  readonly backupID: string;
  readonly sourceGeneration: number;
  readonly sourceRoutingEpoch: number;
  readonly sourceCredentialEpoch: number;
  readonly sourceControlEpoch: number;
  readonly sourceSecurityFloor: number;
}
interface OwnerVaultRestoreCommand extends OwnerVaultControlCommand {
  readonly allocationID: string;
  readonly initID: string;
  readonly sourceGeneration: number;
  readonly targetGeneration: number;
  readonly backupID: string;
  readonly manifestDigest: string;
}
const validControlCommon = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultControlCommand =>
  controlCommonKeys.every((key) => Object.hasOwn(value, key)) &&
  typeof value.ownerID === "string" &&
  opaqueID.test(value.ownerID) &&
  typeof value.vaultID === "string" &&
  opaqueID.test(value.vaultID) &&
  value.ownerID !== value.vaultID &&
  positive(value.generationEpoch) &&
  positive(value.routingEpoch) &&
  positive(value.credentialEpoch) &&
  positive(value.controlEpoch) &&
  positive(value.securityFloor) &&
  typeof value.operationID === "string" &&
  opaqueOperationID.test(value.operationID) &&
  typeof value.jti === "string" &&
  opaqueOperationID.test(value.jti);
const validPrivateInitialize = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultPrivateInitializeCommand =>
  exact(value, [
    ...controlCommonKeys,
    "sourceGeneration",
    "targetGeneration",
    "allocationID",
    "initID",
    "backupID",
    "manifestDigest",
  ]) &&
  validControlCommon(value) &&
  positive(value.sourceGeneration) &&
  positive(value.targetGeneration) &&
  value.targetGeneration === value.generationEpoch &&
  value.sourceGeneration < value.targetGeneration &&
  typeof value.allocationID === "string" &&
  opaqueOperationID.test(value.allocationID) &&
  typeof value.initID === "string" &&
  opaqueOperationID.test(value.initID) &&
  typeof value.backupID === "string" &&
  opaqueOperationID.test(value.backupID) &&
  typeof value.manifestDigest === "string" &&
  validOwnerVaultBackupControlDigest(value.manifestDigest);
const validFence = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultCredentialFenceCommand =>
  exact(value, [
    ...controlCommonKeys,
    "expectedCredentialEpoch",
    "expectedRoutingEpoch",
    "expectedControlEpoch",
    "expectedSecurityFloor",
    "raisedCredentialEpoch",
    "raisedRoutingEpoch",
  ]) &&
  validControlCommon(value) &&
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
  value.raisedRoutingEpoch === value.expectedRoutingEpoch + 1;
const validSnapshot = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultSnapshotCommand =>
  exact(value, [
    ...controlCommonKeys,
    "backupID",
    "sourceGeneration",
    "sourceRoutingEpoch",
    "sourceCredentialEpoch",
    "sourceControlEpoch",
    "sourceSecurityFloor",
  ]) &&
  validControlCommon(value) &&
  typeof value.backupID === "string" &&
  opaqueOperationID.test(value.backupID) &&
  positive(value.sourceGeneration) &&
  positive(value.sourceRoutingEpoch) &&
  positive(value.sourceCredentialEpoch) &&
  positive(value.sourceControlEpoch) &&
  positive(value.sourceSecurityFloor) &&
  value.sourceGeneration === value.generationEpoch &&
  value.sourceRoutingEpoch === value.routingEpoch &&
  value.sourceCredentialEpoch === value.credentialEpoch &&
  value.sourceControlEpoch === value.controlEpoch &&
  value.sourceSecurityFloor === value.securityFloor;
const validRestore = (
  value: Readonly<Record<string, unknown>>,
): value is OwnerVaultRestoreCommand =>
  exact(value, [
    ...controlCommonKeys,
    "allocationID",
    "initID",
    "sourceGeneration",
    "targetGeneration",
    "backupID",
    "manifestDigest",
  ]) &&
  validControlCommon(value) &&
  typeof value.allocationID === "string" &&
  opaqueOperationID.test(value.allocationID) &&
  typeof value.initID === "string" &&
  opaqueOperationID.test(value.initID) &&
  positive(value.sourceGeneration) &&
  positive(value.targetGeneration) &&
  value.targetGeneration === value.generationEpoch &&
  value.sourceGeneration < value.targetGeneration &&
  typeof value.backupID === "string" &&
  opaqueOperationID.test(value.backupID) &&
  typeof value.manifestDigest === "string" &&
  validOwnerVaultBackupControlDigest(value.manifestDigest);

export interface OwnerVaultDODependencies {
  readonly controls: DirectoryControlCapabilityFactory;
  /** User-scoped owner-vault capabilities for fixed internal P06 dispatch. */
  readonly ownerVaultCapabilities?: InternalCapabilityFactoryType;
  /** ovdc1 is deliberately distinct from the historical Directory capability. */
  readonly ownerVaultControls?: OwnerVaultDirectoryControlFactory;
  /** The only configuration authority supplied to P02/P03/C2/C4 providers. */
  readonly production?: OwnerVaultProductionAuthority;
  /** Dedicated ovsa1 ring; it is never substituted with Directory authority. */
  readonly socketAdmissions?: OwnerVaultSocketAdmissionFactory;
  /** Injected only for deterministic Workerd fault/race tests; production uses Web Crypto. */
  readonly socketNonce?: () => Effect.Effect<string>;
  /**
   * Workerd-only fault seam for the two-step socket saga. It is deliberately
   * a constructor dependency, never a request field or persisted record: a
   * deployed composition leaves it absent and cannot expose an extra route.
   */
  readonly socketAdmissionFault?: OwnerVaultSocketAdmissionFault;
}
export type OwnerVaultSocketAdmissionFault =
  | "accept-failure"
  | "early-callback"
  | "finalize-loss"
  | "prepared-loss";
export type OwnerVaultDODependencyProvider = (env: unknown) => OwnerVaultDODependencies | undefined;
export type OwnerVaultDOConstructor = new (
  ctx: DurableObjectState,
  env: Readonly<Record<never, never>>,
) => DurableObject<Readonly<Record<never, never>>>;

/**
 * Fixed internal control surface for a single fresh OwnerVault generation.
 * Directory capability claims bind every byte-relevant field before a durable
 * transaction runs; this object exposes no legacy or general-purpose routes.
 */
export const makeOwnerVaultDO = (
  dependencies: OwnerVaultDODependencies | OwnerVaultDODependencyProvider,
): OwnerVaultDOConstructor => {
  class OwnerVaultV2 extends DurableObject<Readonly<Record<never, never>>> {
    private readonly boundary = makeDurableObjectBoundary(this.ctx);
    private readonly controls: DirectoryControlCapabilityFactory | undefined;
    private readonly ownerVaultCapabilities: InternalCapabilityFactoryType | undefined;
    private readonly ownerVaultControls: OwnerVaultDirectoryControlFactory | undefined;
    private readonly production: OwnerVaultProductionAuthority | undefined;
    private readonly socketAdmissions: OwnerVaultSocketAdmissionFactory | undefined;
    private readonly socketNonce: () => Effect.Effect<string>;
    private readonly socketAdmissionFault: OwnerVaultSocketAdmissionFault | undefined;
    constructor(ctx: DurableObjectState, env: Readonly<Record<never, never>>) {
      super(ctx, env);
      const resolved = typeof dependencies === "function" ? dependencies(env) : dependencies;
      this.controls = resolved?.controls;
      this.ownerVaultCapabilities = resolved?.ownerVaultCapabilities;
      this.ownerVaultControls = resolved?.ownerVaultControls;
      this.production = resolved?.production;
      this.socketAdmissions = resolved?.socketAdmissions;
      this.socketAdmissionFault = resolved?.socketAdmissionFault;
      this.socketNonce =
        resolved?.socketNonce ??
        (() =>
          Effect.sync(() => {
            // Sync frame IDs are fixed 16-byte base64url values. The binding
            // nonce is CSPRNG but must fit the strict P02 frame codec exactly.
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
          }));
    }

    private initialize = (
      envelope: ControlEnvelope<OwnerVaultInitializationCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const binding = {
        resource: DirectoryControlResource.OwnerVaultInitialization,
        method: CapabilityMethod.POST,
        path: ownerVaultInitializationPath,
        canonicalQuery: "",
        bodySHA256: bodyHash(command as unknown as Readonly<Record<string, unknown>>),
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        initDigest: command.initDigest,
        controlEpoch: command.controlEpoch,
        // The fixed Directory control signer binds this durable operation
        // identity as its JTI; no token-derived surrogate is accepted.
        jti: command.operationID,
      } as const;
      const expected = {
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.OwnerVaultInitialization,
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        credentialEpoch: command.credentialEpoch,
        generationEpoch: command.generationEpoch,
        routingEpoch: command.routingEpoch,
        controlEpoch: command.controlEpoch,
        operationID: command.operationID,
        jti: command.operationID,
      } as const;
      if (this.controls === undefined) return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return this.controls.verifier.verify(envelope.capability, binding, expected, now()).pipe(
        Effect.flatMap((claims) => {
          const provider = makeOwnerVaultDomainProvider(repository, commandIdentity(command));
          const capabilityReceipt = capabilityReceiptInput(
            claims,
            envelope.capability,
            ownerVaultInitializationPath,
            command.operationID,
            now(),
          );
          const payload = initPayload(
            command,
            durableReceipt("init", command.operationID, command.initDigest),
          );
          return provider.initialize().pipe(
            Effect.zipRight(provider.claimCapabilityReceipt(capabilityReceipt)),
            Effect.zipRight(
              repository.transact((tx) =>
                tx
                  .get({ category: "control.initialization-ack", identifier: command.operationID })
                  .pipe(
                    Effect.flatMap((existing) => {
                      if (existing !== undefined)
                        return samePayload(existing.payload, payload)
                          ? Effect.succeed(payload.durableReceipt)
                          : rejectControl();
                      return tx
                        .put(
                          {
                            category: "control.initialization-ack",
                            identifier: command.operationID,
                          },
                          payload,
                        )
                        .pipe(Effect.as(payload.durableReceipt));
                    }),
                  ),
              ),
            ),
            Effect.flatMap((receipt) =>
              provider
                .completeCapabilityReceipt(capabilityReceipt, { durableReceipt: receipt })
                .pipe(Effect.as(receipt)),
            ),
            Effect.map(
              (receipt): Response =>
                response({
                  ...command,
                  durableReceipt: receipt,
                } satisfies OwnerVaultInitializationAck),
            ),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private syncFloors = (
      envelope: ControlEnvelope<OwnerVaultFloorSyncCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const binding = {
        resource: DirectoryControlResource.OwnerVaultFloorSync,
        method: CapabilityMethod.POST,
        path: ownerVaultFloorSyncPath,
        canonicalQuery: "",
        bodySHA256: bodyHash(command as unknown as Readonly<Record<string, unknown>>),
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        floorSyncDigest: command.floorSyncDigest,
        controlEpoch: command.controlEpoch,
        // Floor reconciliation persists the same caller-generated durable
        // operation as the signed capability JTI.
        jti: command.operationID,
      } as const;
      const expected = {
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.OwnerVaultFloorSync,
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        credentialEpoch: command.credentialEpoch,
        generationEpoch: command.generationEpoch,
        routingEpoch: command.routingEpoch,
        controlEpoch: command.controlEpoch,
        operationID: command.operationID,
        jti: command.operationID,
      } as const;
      if (this.controls === undefined) return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return this.controls.verifier.verify(envelope.capability, binding, expected, now()).pipe(
        Effect.flatMap((claims) => {
          const provider = makeOwnerVaultDomainProvider(repository, commandIdentity(command));
          const capabilityReceipt = capabilityReceiptInput(
            claims,
            envelope.capability,
            ownerVaultFloorSyncPath,
            command.operationID,
            now(),
          );
          return provider.claimCapabilityReceipt(capabilityReceipt).pipe(
            Effect.zipRight(
              repository.transact((tx) => {
                const payload = floorPayload(
                  command,
                  durableReceipt("floor", command.operationID, command.floorSyncDigest),
                );
                return tx.get({ category: "root.identity" }).pipe(
                  Effect.flatMap((identity) =>
                    identity === undefined || !samePrivateIdentity(identity.payload, command)
                      ? rejectControl()
                      : tx.get({ category: "control.floor-sync", identifier: command.operationID }),
                  ),
                  Effect.flatMap((existing) => {
                    if (existing !== undefined)
                      return samePayload(existing.payload, payload)
                        ? Effect.succeed(payload.durableReceipt)
                        : rejectControl();
                    return tx.get({ category: "control.floor-sync", identifier: "current" }).pipe(
                      Effect.flatMap((current) => {
                        if (current !== undefined) {
                          const prior = current.payload;
                          if (
                            typeof prior.credentialEpoch !== "number" ||
                            typeof prior.routingEpoch !== "number" ||
                            typeof prior.controlEpoch !== "number" ||
                            command.credentialEpoch < prior.credentialEpoch ||
                            command.routingEpoch < prior.routingEpoch ||
                            command.controlEpoch < prior.controlEpoch
                          )
                            return rejectControl();
                        }
                        return tx
                          .put(
                            { category: "control.floor-sync", identifier: command.operationID },
                            payload,
                          )
                          .pipe(
                            Effect.zipRight(
                              tx.put(
                                { category: "control.floor-sync", identifier: "current" },
                                payload,
                              ),
                            ),
                            Effect.as(payload.durableReceipt),
                          );
                      }),
                    );
                  }),
                );
              }),
            ),
            Effect.flatMap((receipt) =>
              provider
                .completeCapabilityReceipt(capabilityReceipt, { durableReceipt: receipt })
                .pipe(Effect.as(receipt)),
            ),
          );
        }),
        Effect.map(
          (receipt): Response =>
            response({ ...command, durableReceipt: receipt } satisfies OwnerVaultFloorSyncAck),
        ),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private privateInitialize = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultPrivateInitializeCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const root = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.generationEpoch,
        namespaceState: "PRIVATE" as const,
      };
      const binding = {
        resource: OwnerVaultDirectoryControlResource.PrivateInitialize,
        path: ownerVaultPrivateInitializePath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
      if (graph === undefined) return Effect.succeed(response({ ok: false }, 403));
      const receipt = durableReceipt("private-init", command.operationID, command.manifestDigest);
      const acknowledgement = {
        kind: "private-initialize",
        privateRestoreLink: privateRestoreLink(command),
        controlDigest: bodyHash(command),
        durableReceipt: receipt,
      } as const;
      const authority = {
        kind: "authority",
        credentialEpoch: command.credentialEpoch,
        routingEpoch: command.routingEpoch,
        controlEpoch: command.controlEpoch,
        securityFloor: command.securityFloor,
      } as const;
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap((claims) => {
          const capabilityReceipt = capabilityReceiptInput(
            claims,
            envelope.capability,
            ownerVaultPrivateInitializePath,
            command.operationID,
            now(),
          );
          return graph.domains.initialize().pipe(
            Effect.zipRight(graph.domains.claimCapabilityReceipt(capabilityReceipt)),
            Effect.zipRight(
              repository.transact((tx) =>
                tx.get({ category: "control.initialization-ack", identifier: command.initID }).pipe(
                  Effect.flatMap((existing) => {
                    if (existing !== undefined)
                      return samePayload(existing.payload, acknowledgement)
                        ? Effect.succeed(receipt)
                        : rejectControl();
                    return tx.get({ category: "control.floor-sync", identifier: "authority" }).pipe(
                      Effect.flatMap((prior) => {
                        if (prior !== undefined && !samePayload(prior.payload, authority))
                          return rejectControl();
                        return tx
                          .put(
                            { category: "root.floors" },
                            { securityFloor: command.securityFloor },
                          )
                          .pipe(
                            Effect.zipRight(
                              tx.put(
                                {
                                  category: "control.initialization-ack",
                                  identifier: command.initID,
                                },
                                acknowledgement,
                              ),
                            ),
                            Effect.zipRight(
                              tx.put(
                                { category: "control.floor-sync", identifier: "authority" },
                                authority,
                              ),
                            ),
                            Effect.as(receipt),
                          );
                      }),
                    );
                  }),
                ),
              ),
            ),
            Effect.flatMap((durableReceipt) =>
              graph.domains
                .completeCapabilityReceipt(capabilityReceipt, { durableReceipt })
                .pipe(Effect.as(durableReceipt)),
            ),
          );
        }),
        Effect.map((durableReceipt): Response => response({ ...command, durableReceipt })),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private credentialFence = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultCredentialFenceCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const binding = {
        resource: OwnerVaultDirectoryControlResource.CredentialFence,
        path: ownerVaultCredentialFencePath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const receipt = durableReceipt("credential-fence", command.operationID, bodyHash(command));
      const acknowledgement = {
        kind: "credential-fence",
        controlDigest: bodyHash(command),
        durableReceipt: receipt,
      } as const;
      const raisedAuthority = {
        kind: "authority",
        credentialEpoch: command.raisedCredentialEpoch,
        routingEpoch: command.raisedRoutingEpoch,
        controlEpoch: command.expectedControlEpoch,
        securityFloor: command.expectedSecurityFloor,
      } as const;
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap((claims) =>
          this.socketAuthority().pipe(
            Effect.flatMap((authority) =>
              this.withCapabilityReceipt(
                makeOwnerVaultDomainProvider(repository, {
                  ownerID: authority.ownerID,
                  vaultID: authority.vaultID,
                  generationEpoch: authority.generationEpoch,
                  namespaceState: authority.namespaceState,
                }),
                claims,
                envelope.capability,
                ownerVaultCredentialFencePath,
                command.operationID,
                () =>
                  repository.transact((tx) =>
                    tx
                      .get({ category: "control.floor-sync", identifier: command.operationID })
                      .pipe(
                        Effect.flatMap((priorAck) => {
                          if (priorAck !== undefined)
                            return samePayload(priorAck.payload, acknowledgement)
                              ? Effect.succeed(receipt)
                              : rejectControl();
                          return Effect.all([
                            tx.get({ category: "root.identity" }),
                            tx.get({ category: "root.floors" }),
                            tx.get({ category: "root.admission" }),
                            tx.get({ category: "control.floor-sync", identifier: "authority" }),
                          ]).pipe(
                            Effect.flatMap(([identity, floors, admission, authority]) => {
                              const root =
                                identity === undefined ? undefined : record(identity.payload);
                              const currentFloors =
                                floors === undefined ? undefined : record(floors.payload);
                              const currentAdmission =
                                admission === undefined ? undefined : record(admission.payload);
                              const currentAuthority =
                                authority === undefined ? undefined : record(authority.payload);
                              const expectedAuthority = {
                                kind: "authority",
                                credentialEpoch: command.expectedCredentialEpoch,
                                routingEpoch: command.expectedRoutingEpoch,
                                controlEpoch: command.expectedControlEpoch,
                                securityFloor: command.expectedSecurityFloor,
                              };
                              if (
                                root === undefined ||
                                !exact(root, [
                                  "ownerID",
                                  "vaultID",
                                  "generationEpoch",
                                  "namespaceState",
                                ]) ||
                                root.ownerID !== command.ownerID ||
                                root.vaultID !== command.vaultID ||
                                root.generationEpoch !== command.generationEpoch ||
                                (root.namespaceState !== "PRIVATE" &&
                                  root.namespaceState !== "ACTIVE") ||
                                currentFloors === undefined ||
                                !exact(currentFloors, ["securityFloor"]) ||
                                currentFloors.securityFloor !== command.expectedSecurityFloor ||
                                currentAdmission === undefined ||
                                typeof currentAdmission.stopped !== "boolean" ||
                                currentAdmission.stopped ||
                                currentAuthority === undefined ||
                                !samePayload(currentAuthority, expectedAuthority)
                              )
                                return rejectControl();
                              return tx
                                .put(
                                  {
                                    category: "control.floor-sync",
                                    identifier: command.operationID,
                                  },
                                  acknowledgement,
                                )
                                .pipe(
                                  Effect.zipRight(
                                    tx.put(
                                      { category: "control.floor-sync", identifier: "authority" },
                                      raisedAuthority,
                                    ),
                                  ),
                                  Effect.zipRight(
                                    tx.put(
                                      { category: "root.admission" },
                                      { ...currentAdmission, stopped: true },
                                    ),
                                  ),
                                  Effect.as(receipt),
                                );
                            }),
                          );
                        }),
                      ),
                  ),
                () => ({ durableReceipt: receipt }),
                (stored) =>
                  typeof stored.durableReceipt === "string" ? stored.durableReceipt : undefined,
              ),
            ),
          ),
        ),
        // The acknowledgement transaction has committed before a live socket
        // is observed. Attachments contain only IDs/expiry, so cleanup cannot
        // resurrect a bearer or carry authority across a restart.
        Effect.tap(() =>
          Effect.sync(() => {
            for (const socket of this.ctx.getWebSockets()) socket.close(4401, "credential fenced");
          }),
        ),
        Effect.map((durableReceipt): Response => response({ ...command, durableReceipt })),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private snapshot = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultSnapshotCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const root = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.generationEpoch,
        namespaceState: "PRIVATE" as const,
      };
      const binding = {
        resource: OwnerVaultDirectoryControlResource.Snapshot,
        path: ownerVaultSnapshotPath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const graph = makeOwnerVaultProviderGraph(
        makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage),
        root,
        this.production,
      );
      if (graph === undefined) return Effect.succeed(response({ ok: false }, 403));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const durable = durableReceipt("snapshot", command.operationID, bodyHash(command));
      const acknowledgement = {
        kind: "snapshot",
        operationID: command.operationID,
        backupID: command.backupID,
        controlDigest: bodyHash(command),
        durableReceipt: durable,
        state: "PREPARED",
      } as const;
      type SnapshotJournal =
        | { readonly phase: "PREPARED" }
        | { readonly phase: "COMPLETED"; readonly manifestDigest: string };
      const source = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.sourceGeneration,
      } as const;
      const completeAcknowledgement = (manifestDigest: string): Effect.Effect<string, unknown> => {
        const completed = { ...acknowledgement, state: "COMPLETED" as const, manifestDigest };
        return repository
          .transact((tx) =>
            tx.get({ category: "control.initialization-ack", identifier: command.jti }).pipe(
              Effect.flatMap((existing) =>
                existing !== undefined && samePayload(existing.payload, acknowledgement)
                  ? tx
                      .put(
                        {
                          category: "control.initialization-ack",
                          identifier: command.jti,
                        },
                        completed,
                      )
                      .pipe(Effect.as(manifestDigest))
                  : existing !== undefined && samePayload(existing.payload, completed)
                    ? Effect.succeed(manifestDigest)
                    : rejectControl<string>(),
              ),
            ),
          )
          .pipe(Effect.mapError((error): unknown => error));
      };
      const executeSnapshot = (): Effect.Effect<string, unknown> =>
        repository
          .transact<SnapshotJournal>((tx) =>
            tx.get({ category: "control.initialization-ack", identifier: command.jti }).pipe(
              Effect.flatMap((existing) => {
                if (existing === undefined)
                  return tx
                    .put(
                      { category: "control.initialization-ack", identifier: command.jti },
                      acknowledgement,
                    )
                    .pipe(Effect.as<SnapshotJournal>({ phase: "PREPARED" }));
                if (samePayload(existing.payload, acknowledgement))
                  return Effect.succeed<SnapshotJournal>({ phase: "PREPARED" });
                const completed = record(existing.payload);
                return completed !== undefined &&
                  exact(completed, [
                    "kind",
                    "operationID",
                    "backupID",
                    "controlDigest",
                    "durableReceipt",
                    "state",
                    "manifestDigest",
                  ]) &&
                  completed.kind === acknowledgement.kind &&
                  completed.operationID === acknowledgement.operationID &&
                  completed.backupID === acknowledgement.backupID &&
                  completed.controlDigest === acknowledgement.controlDigest &&
                  completed.durableReceipt === acknowledgement.durableReceipt &&
                  completed.state === "COMPLETED" &&
                  validOwnerVaultBackupControlDigest(completed.manifestDigest)
                  ? Effect.succeed<SnapshotJournal>({
                      phase: "COMPLETED" as const,
                      manifestDigest: completed.manifestDigest,
                    })
                  : rejectControl<SnapshotJournal>();
              }),
            ),
          )
          .pipe(
            Effect.flatMap((journal) =>
              journal.phase === "COMPLETED"
                ? Effect.succeed(journal.manifestDigest)
                : graph.snapshots.completedManifestDigest(source, command.backupID).pipe(
                    Effect.flatMap((recovered) =>
                      recovered === undefined
                        ? graph.backupRuntime().pipe(
                            Effect.flatMap((runtime) =>
                              createOwnerVaultBackup(
                                graph.snapshots,
                                runtime,
                                source,
                                command.backupID,
                              ),
                            ),
                            Effect.flatMap((manifest) => {
                              const signed = canonicalSignedManifestBytes(manifest);
                              return signed === undefined
                                ? rejectControl<string>()
                                : completeAcknowledgement(ownerVaultBackupControlDigest(signed));
                            }),
                          )
                        : completeAcknowledgement(
                            ownerVaultBackupControlDigest(
                              Uint8Array.from(atob(recovered), (entry) => entry.charCodeAt(0)),
                            ),
                          ),
                    ),
                  ),
            ),
          );
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap((claims) =>
          this.withCapabilityReceipt(
            graph.domains,
            claims,
            envelope.capability,
            ownerVaultSnapshotPath,
            command.operationID,
            executeSnapshot,
            (manifestDigest) => ({
              backupID: command.backupID,
              manifestDigest,
              durableReceipt: durable,
            }),
            (stored) =>
              stored.backupID === command.backupID &&
              typeof stored.manifestDigest === "string" &&
              stored.durableReceipt === durable
                ? stored.manifestDigest
                : undefined,
          ),
        ),
        Effect.map(
          (manifestDigest): Response =>
            response({
              ok: true,
              backupID: command.backupID,
              manifestDigest,
              durableReceipt: durable,
            }),
        ),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private restore = (
      envelope: OwnerVaultControlEnvelope<OwnerVaultRestoreCommand>,
    ): Effect.Effect<Response> => {
      const command = envelope.command;
      const root = {
        ownerID: command.ownerID,
        vaultID: command.vaultID,
        generationEpoch: command.targetGeneration,
        namespaceState: "PRIVATE" as const,
      };
      const binding = {
        resource: OwnerVaultDirectoryControlResource.Restore,
        path: ownerVaultRestorePath,
        method: "POST" as const,
        canonicalQuery: "" as const,
        bodySHA256: bodyHash(command),
        ...command,
      } as const;
      if (this.ownerVaultControls === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
      if (graph === undefined) return Effect.succeed(response({ ok: false }, 403));
      const durable = durableReceipt("restore", command.operationID, bodyHash(command));
      const acknowledgement = {
        kind: "restore",
        operationID: command.operationID,
        backupID: command.backupID,
        manifestDigest: command.manifestDigest,
        controlDigest: bodyHash(command),
        durableReceipt: durable,
        state: "PREPARED",
      } as const;
      type RestoreJournal = { readonly phase: "PREPARED" } | { readonly phase: "COMPLETED" };
      const completeAcknowledgement = (): Effect.Effect<void, unknown> => {
        const completed = { ...acknowledgement, state: "COMPLETED" as const };
        return repository
          .transact((tx) =>
            tx
              .get({ category: "control.initialization-ack", identifier: command.jti })
              .pipe(
                Effect.flatMap((existing) =>
                  existing !== undefined && samePayload(existing.payload, acknowledgement)
                    ? tx
                        .put(
                          { category: "control.initialization-ack", identifier: command.jti },
                          completed,
                        )
                        .pipe(Effect.asVoid)
                    : existing !== undefined && samePayload(existing.payload, completed)
                      ? Effect.void
                      : rejectControl<void>(),
                ),
              ),
          )
          .pipe(Effect.mapError((error): unknown => error));
      };
      const assertFreshPrivateTarget = (): Effect.Effect<void, OwnerVaultBackupError> =>
        repository
          .transact((tx) =>
            tx.get({ category: "control.initialization-ack", identifier: command.initID }).pipe(
              Effect.flatMap((ack) => {
                const payload = ack === undefined ? undefined : record(ack.payload);
                return payload !== undefined &&
                  samePayload(payload, {
                    kind: "private-initialize",
                    privateRestoreLink: privateRestoreLink(command),
                    controlDigest: payload.controlDigest,
                    durableReceipt: payload.durableReceipt,
                  })
                  ? Effect.void
                  : Effect.fail({
                      _tag: "OwnerVaultStorageError",
                      reason: "identity_conflict",
                    } as const);
              }),
            ),
          )
          .pipe(
            Effect.mapError(() => new OwnerVaultBackupError({ reason: "private_target_required" })),
          );
      const executeRestore = (): Effect.Effect<"restored", unknown> =>
        repository
          .transact<RestoreJournal>((tx) =>
            tx.get({ category: "control.initialization-ack", identifier: command.jti }).pipe(
              Effect.flatMap(
                (existing): Effect.Effect<RestoreJournal, OwnerVaultStorageTransactionFailure> =>
                  existing === undefined
                    ? tx
                        .put(
                          { category: "control.initialization-ack", identifier: command.jti },
                          acknowledgement,
                        )
                        .pipe(Effect.as<RestoreJournal>({ phase: "PREPARED" }))
                    : samePayload(existing.payload, acknowledgement)
                      ? Effect.succeed<RestoreJournal>({ phase: "PREPARED" })
                      : (() => {
                          const completed = record(existing.payload);
                          return completed !== undefined &&
                            exact(completed, [
                              "kind",
                              "operationID",
                              "backupID",
                              "manifestDigest",
                              "controlDigest",
                              "durableReceipt",
                              "state",
                            ]) &&
                            completed.kind === acknowledgement.kind &&
                            completed.operationID === acknowledgement.operationID &&
                            completed.backupID === acknowledgement.backupID &&
                            completed.manifestDigest === acknowledgement.manifestDigest &&
                            completed.controlDigest === acknowledgement.controlDigest &&
                            completed.durableReceipt === acknowledgement.durableReceipt &&
                            completed.state === "COMPLETED"
                            ? Effect.succeed<RestoreJournal>({ phase: "COMPLETED" })
                            : rejectControl<RestoreJournal>();
                        })(),
              ),
            ),
          )
          .pipe(
            Effect.flatMap((journal) =>
              journal.phase === "COMPLETED"
                ? Effect.void
                : graph.backupRuntime().pipe(
                    Effect.flatMap((runtime) =>
                      restoreOwnerVaultBackup(
                        runtime,
                        graph.privateRestoreTarget(assertFreshPrivateTarget),
                        {
                          ownerID: command.ownerID,
                          vaultID: command.vaultID,
                          generationEpoch: command.sourceGeneration,
                        },
                        command.backupID,
                        command.manifestDigest,
                      ),
                    ),
                    Effect.zipRight(completeAcknowledgement()),
                  ),
            ),
            Effect.as("restored" as const),
          );
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap((claims) =>
          this.withCapabilityReceipt(
            graph.domains,
            claims,
            envelope.capability,
            ownerVaultRestorePath,
            command.operationID,
            executeRestore,
            () => ({
              backupID: command.backupID,
              targetGeneration: command.targetGeneration,
              durableReceipt: durable,
            }),
            (stored) =>
              stored.backupID === command.backupID &&
              stored.targetGeneration === command.targetGeneration &&
              stored.durableReceipt === durable
                ? "restored"
                : undefined,
          ),
        ),
        Effect.as(
          response({
            ok: true,
            backupID: command.backupID,
            targetGeneration: command.targetGeneration,
            durableReceipt: durable,
          }),
        ),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );
    };

    private socketAuthority = (): Effect.Effect<SocketAuthority, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "root.identity" }),
          tx.get({ category: "root.floors" }),
          tx.get({ category: "root.admission" }),
          tx.get({ category: "control.floor-sync", identifier: "authority" }),
        ]).pipe(
          Effect.flatMap(([identity, floors, admission, authority]) => {
            const root = identity === undefined ? undefined : record(identity.payload);
            const floor = floors === undefined ? undefined : record(floors.payload);
            const counts =
              admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            const current = authority === undefined ? undefined : record(authority.payload);
            if (
              root === undefined ||
              !exact(root, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) ||
              typeof root.ownerID !== "string" ||
              typeof root.vaultID !== "string" ||
              !positive(root.generationEpoch) ||
              (root.namespaceState !== "PRIVATE" && root.namespaceState !== "ACTIVE") ||
              floor === undefined ||
              !exact(floor, ["securityFloor"]) ||
              !positive(floor.securityFloor) ||
              counts === undefined ||
              current === undefined ||
              !exact(current, [
                "kind",
                "credentialEpoch",
                "routingEpoch",
                "controlEpoch",
                "securityFloor",
              ]) ||
              current.kind !== "authority" ||
              !positive(current.credentialEpoch) ||
              !positive(current.routingEpoch) ||
              !positive(current.controlEpoch) ||
              current.securityFloor !== floor.securityFloor
            )
              return rejectControl<SocketAuthority>();
            return Effect.succeed({
              ownerID: root.ownerID,
              vaultID: root.vaultID,
              generationEpoch: root.generationEpoch,
              namespaceState: root.namespaceState,
              routingEpoch: current.routingEpoch,
              credentialEpoch: current.credentialEpoch,
              controlEpoch: current.controlEpoch,
              securityFloor: floor.securityFloor,
              admission: counts,
            });
          }),
        ),
      );
    };

    /** Multiple receipt families share one DO alarm; admission can only move
     * it earlier. The alarm itself recomputes the exact next bounded cursor. */
    private scheduleReconciliation = (atMilliseconds: number): Effect.Effect<void, unknown> =>
      this.boundary.storage
        .getAlarm()
        .pipe(
          Effect.flatMap((current) =>
            current === null || current > atMilliseconds
              ? this.boundary.storage.setAlarm(atMilliseconds)
              : Effect.void,
          ),
        );

    private reconcileCapabilityReceipts = (
      nowSeconds: number,
    ): Effect.Effect<number | undefined, unknown> =>
      this.socketAuthority().pipe(
        Effect.flatMap((authority): Effect.Effect<number | undefined, unknown> => {
          const root = {
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
            generationEpoch: authority.generationEpoch,
            namespaceState: authority.namespaceState,
          } as const;
          const graph =
            this.production === undefined
              ? undefined
              : makeOwnerVaultProviderGraph(
                  makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage),
                  root,
                  this.production,
                );
          return graph === undefined
            ? rejectControl<number | undefined>()
            : graph.domains.expireCapabilities(nowSeconds);
        }),
      );

    /**
     * Adapter for the P02 service.  It deliberately exposes the real P02
     * challenge and registration path over this object’s one repository
     * authority; no test or transport path may seed device rows directly.
     */
    private deviceServiceFor = (
      authority: SocketAuthority,
      domains: OwnerVaultDomainProvider,
      repository: OwnerVaultStorageRepository,
    ): Effect.Effect<DeviceServiceType> => {
      const root = authority;
      const mapDomain = <A>(effect: Effect.Effect<A, OwnerVaultDomainError>) =>
        effect.pipe(Effect.mapError(deviceErrorFromDomain));
      const registry: DeviceRegistryRepositoryType = {
        issueChallenge: (input, nowMilliseconds) => {
          if (!sameDeviceRoot(root, input)) return Effect.fail(deviceError("invalid_request"));
          return mapDomain(
            domains.issueChallenge(
              {
                challengeID: input.challengeID,
                challengeBase64: input.challengeBase64,
                challengeAudience: input.challengeAudience,
                devicePublicKey: input.devicePublicKey,
                expiresAtMilliseconds: input.expiresAt,
                consumed: input.consumed,
              },
              nowMilliseconds,
            ),
          ).pipe(
            Effect.map((challenge) => ({
              ownerID: root.ownerID,
              vaultID: root.vaultID,
              generationEpoch: root.generationEpoch,
              challengeID: challenge.challengeID,
              challengeBase64: challenge.challengeBase64,
              challengeAudience: challenge.challengeAudience,
              devicePublicKey: challenge.devicePublicKey,
              expiresAt: challenge.expiresAtMilliseconds,
              consumed: challenge.consumed,
            })),
          );
        },
        getChallenge: (challengeID, nowMilliseconds) =>
          mapDomain(domains.readChallenge(challengeID, nowMilliseconds)).pipe(
            Effect.map((challenge) => ({
              ownerID: root.ownerID,
              vaultID: root.vaultID,
              generationEpoch: root.generationEpoch,
              challengeID: challenge.challengeID,
              challengeBase64: challenge.challengeBase64,
              challengeAudience: challenge.challengeAudience,
              devicePublicKey: challenge.devicePublicKey,
              expiresAt: challenge.expiresAtMilliseconds,
              consumed: challenge.consumed,
            })),
          ),
        getRegistrationReceipt: ({ idempotencyKey, proofFingerprint }) =>
          repository
            .transact((tx) => tx.get({ category: "operation-receipt", identifier: idempotencyKey }))
            .pipe(
              Effect.flatMap((stored) => {
                if (stored === undefined) return Effect.succeed(undefined);
                const receipt = record(stored.payload);
                const result = receipt === undefined ? undefined : record(receipt.result);
                const storedDevice =
                  result === undefined ? undefined : socketDeviceRecord(result.device);
                if (
                  receipt === undefined ||
                  !exact(receipt, ["expiresAtSeconds", "fingerprint", "kind", "result"]) ||
                  receipt.kind !== "device-registration" ||
                  receipt.fingerprint !== proofFingerprint ||
                  storedDevice === undefined
                )
                  return Effect.fail(deviceError("idempotency_conflict"));
                return Effect.succeed({
                  device: deviceRecordFromDomain(root, storedDevice),
                  replayed: true,
                });
              }),
              Effect.catchAll(() => Effect.fail(deviceError("temporarily_unavailable"))),
            ),
        registerFromChallenge: (input) => {
          if (!sameDeviceRoot(root, input.device))
            return Effect.fail(deviceError("invalid_request"));
          return mapDomain(
            domains.registerDevice({
              registrationID: input.idempotencyKey,
              proofFingerprint: input.proofFingerprint,
              challengeID: input.challengeID,
              device: {
                deviceID: input.device.deviceID,
                publicKeySPKI: input.device.publicKeySPKI,
                authEpoch: input.device.authEpoch,
                credentialEpoch: input.device.credentialEpoch,
                revoked: input.device.revoked,
                // P02's bootstrap record starts at floor zero. The target
                // namespace may already have a higher durable floor (as a
                // PRIVATE restore target does), which must win at the one
                // registration write rather than admitting an immediately
                // stale device.
                securityFloor: Math.max(input.device.securityFloor, root.securityFloor),
              },
              nowMilliseconds: input.now,
            }),
          ).pipe(
            Effect.map((registered) => ({
              device: deviceRecordFromDomain(root, registered.device),
              replayed: registered.replayed,
            })),
          );
        },
        getDevice: (deviceID) =>
          mapDomain(domains.getDevice(deviceID)).pipe(
            Effect.map((device) => deviceRecordFromDomain(root, device)),
          ),
        /**
         * Signature verification reloads the durable actor here. The actual
         * nonce claim is performed by `domains.append` in the same transaction
         * as the operation receipt/log write, so an interrupted verification
         * cannot burn a nonce without an append acknowledgement.
         */
        authorizeAndClaimNonce: (input) => {
          if (
            !sameDeviceRoot(root, input.expectedBinding) ||
            input.expectedCredentialEpoch !== authority.credentialEpoch ||
            input.expectedGenerationEpoch !== authority.generationEpoch ||
            input.now < 0 ||
            input.expiresAt <= input.now
          )
            return Effect.fail(deviceError("invalid_request"));
          return mapDomain(domains.getDevice(input.expectedDeviceID)).pipe(
            Effect.flatMap((device) =>
              device.revoked ||
              device.authEpoch !== input.expectedAuthEpoch ||
              device.credentialEpoch !== input.expectedCredentialEpoch ||
              device.securityFloor < input.expectedSecurityFloor
                ? Effect.fail(deviceError("device_revoked"))
                : Effect.succeed(deviceRecordFromDomain(root, device)),
            ),
          );
        },
        revokeDevice: () => Effect.fail(deviceError("recovery_not_configured")),
      };
      const recovery = {
        rebindExistingDevice: () => Effect.fail(deviceError("recovery_not_configured")),
      } satisfies ExistingDeviceRecoveryRebinder;
      return makeDeviceService.pipe(
        Effect.provideService(P256Crypto, makeP256Crypto()),
        Effect.provideService(DeviceRegistryRepository, registry),
        Effect.provideService(ExistingDeviceRecoveryRebinder, recovery),
      );
    };

    private userCapability = <C>(
      envelope: ControlEnvelope<C>,
      command: Readonly<Record<string, unknown>>,
      path: string,
      authority: SocketAuthority,
    ): Effect.Effect<CapabilityClaims, unknown> => {
      if (this.ownerVaultCapabilities === undefined || authority.admission.stopped)
        return rejectControl<CapabilityClaims>();
      const binding = {
        method: CapabilityMethod.POST,
        path,
        canonicalQuery: "",
        bodySHA256: bodyHash(command),
        ownerID: authority.ownerID,
        vaultID: authority.vaultID,
      } as const;
      return this.ownerVaultCapabilities.verifier
        .verify(
          envelope.capability,
          binding,
          {
            audience: CapabilityAudience.OwnerVault,
            authority: CapabilityAuthority.OwnerVault,
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
          },
          now(),
        )
        .pipe(
          Effect.flatMap((claims) =>
            claims.credentialEpoch === authority.credentialEpoch &&
            claims.generationEpoch === authority.generationEpoch
              ? Effect.succeed(claims)
              : rejectControl<CapabilityClaims>(),
          ),
        );
    };

    /**
     * One verified capability is claimed before its endpoint journal can
     * mutate state, then completed with the endpoint's exact canonical
     * result. A completed receipt returns its validated exact result and
     * never re-enters the endpoint journal.
     */
    private withCapabilityReceipt = <A>(
      domains: OwnerVaultDomainProvider,
      claims: Readonly<{ jti: string; expiresAt: number }>,
      capability: Readonly<{ value: string }>,
      resource: string,
      operationID: string,
      run: () => Effect.Effect<A, unknown>,
      result: (value: A) => Readonly<Record<string, unknown>>,
      replay: (result: Readonly<Record<string, unknown>>) => A | undefined,
    ): Effect.Effect<A, unknown> => {
      const receipt = capabilityReceiptInput(claims, capability, resource, operationID, now());
      return domains.claimCapabilityReceipt(receipt).pipe(
        Effect.flatMap((claimed) => {
          if (claimed.state === "COMPLETED") {
            const replayed = claimed.result === undefined ? undefined : replay(claimed.result);
            return replayed === undefined
              ? Effect.fail(new OwnerVaultDomainError({ reason: "replay_conflict" }))
              : Effect.succeed(replayed);
          }
          return run().pipe(
            Effect.flatMap((value) =>
              domains.completeCapabilityReceipt(receipt, result(value)).pipe(Effect.as(value)),
            ),
          );
        }),
      );
    };

    private deviceChallenge = (envelope: ControlEnvelope<DeviceChallengeRequest>) =>
      this.socketAuthority().pipe(
        Effect.flatMap((authority) => {
          const root = {
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
            generationEpoch: authority.generationEpoch,
            namespaceState: authority.namespaceState,
          } as const;
          if (this.production === undefined) return rejectControl<Response>();
          const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
          const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
          if (graph === undefined) return rejectControl<Response>();
          return this.userCapability(
            envelope,
            envelope.command as unknown as Readonly<Record<string, unknown>>,
            ownerVaultDeviceChallengePath,
            authority,
          ).pipe(
            Effect.flatMap((claims): Effect.Effect<Response, unknown> => {
              // DeviceChallenge has no separately signed operation field. Its
              // canonical one-shot operation identity is therefore the signed
              // capability JTI, never a bearer-derived surrogate.
              const receipt = capabilityReceiptInput(
                claims,
                envelope.capability,
                ownerVaultDeviceChallengePath,
                claims.jti,
                now(),
              );
              return graph.domains.claimCapabilityReceipt(receipt).pipe(
                Effect.flatMap((claimed): Effect.Effect<Response, OwnerVaultDomainError> => {
                  if (claimed.state === "COMPLETED") {
                    if (claimed.result === undefined)
                      return Effect.fail(new OwnerVaultDomainError({ reason: "replay_conflict" }));
                    try {
                      return Effect.succeed(
                        response(decodeDeviceChallengeResponse(claimed.result)),
                      );
                    } catch {
                      return Effect.fail(new OwnerVaultDomainError({ reason: "replay_conflict" }));
                    }
                  }
                  return this.deviceServiceFor(authority, graph.domains, repository).pipe(
                    Effect.flatMap((devices) =>
                      devices.createAccessChallenge(
                        {
                          ownerID: authority.ownerID,
                          vaultID: authority.vaultID,
                          generationEpoch: authority.generationEpoch,
                        },
                        envelope.command,
                        Date.now(),
                      ),
                    ),
                    Effect.flatMap((challenge) =>
                      graph.domains
                        .completeCapabilityReceipt(
                          receipt,
                          challenge as unknown as Readonly<Record<string, unknown>>,
                        )
                        .pipe(Effect.as(response(challenge))),
                    ),
                    Effect.mapError(
                      () => new OwnerVaultDomainError({ reason: "authorization_denied" }),
                    ),
                  );
                }),
              );
            }),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );

    private deviceComplete = (envelope: ControlEnvelope<DeviceRegisterRequest>) =>
      this.socketAuthority().pipe(
        Effect.flatMap((authority) => {
          const root = {
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
            generationEpoch: authority.generationEpoch,
            namespaceState: authority.namespaceState,
          } as const;
          if (this.production === undefined) return rejectControl<Response>();
          const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
          const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
          if (graph === undefined) return rejectControl<Response>();
          return this.userCapability(
            envelope,
            envelope.command as unknown as Readonly<Record<string, unknown>>,
            ownerVaultDeviceCompletePath,
            authority,
          ).pipe(
            Effect.flatMap((claims): Effect.Effect<Response, unknown> => {
              // DeviceComplete carries its own signed idempotency key, which
              // is the durable operation identity for this receipt.
              const receipt = capabilityReceiptInput(
                claims,
                envelope.capability,
                ownerVaultDeviceCompletePath,
                envelope.command.idempotencyKey,
                now(),
              );
              return graph.domains.claimCapabilityReceipt(receipt).pipe(
                Effect.flatMap((claimed): Effect.Effect<Response, OwnerVaultDomainError> => {
                  if (claimed.state === "COMPLETED") {
                    if (claimed.result === undefined)
                      return Effect.fail(new OwnerVaultDomainError({ reason: "replay_conflict" }));
                    try {
                      return Effect.succeed(response(decodeDeviceRegisterResponse(claimed.result)));
                    } catch {
                      return Effect.fail(new OwnerVaultDomainError({ reason: "replay_conflict" }));
                    }
                  }
                  return this.deviceServiceFor(authority, graph.domains, repository).pipe(
                    Effect.flatMap((devices) =>
                      devices.registerInitialOrAdditionalDevice(envelope.command, Date.now()),
                    ),
                    Effect.flatMap((registered) =>
                      graph.domains
                        .completeCapabilityReceipt(
                          receipt,
                          registered as unknown as Readonly<Record<string, unknown>>,
                        )
                        .pipe(Effect.as(response(registered))),
                    ),
                    Effect.mapError(
                      () => new OwnerVaultDomainError({ reason: "authorization_denied" }),
                    ),
                  );
                }),
              );
            }),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );

    /**
     * P06 dispatches the already device-signed public mutation command to this
     * private fixed target. The outer OwnerVault capability selects the vault
     * and exact bytes; P02 verifies the device signature; P05 commits nonce,
     * capability JTI, receipt, and append row through one domain transaction.
     */
    private opaqueAppend = (envelope: ControlEnvelope<MutationRequest>) =>
      this.socketAuthority().pipe(
        Effect.flatMap((authority) => {
          const root = {
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
            generationEpoch: authority.generationEpoch,
            namespaceState: authority.namespaceState,
          } as const;
          if (this.production === undefined) return rejectControl<Response>();
          const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
          const graph = makeOwnerVaultProviderGraph(repository, root, this.production);
          if (graph === undefined) return rejectControl<Response>();
          const nowMilliseconds = Date.now();
          const nowSeconds = Math.floor(nowMilliseconds / 1_000);
          return this.userCapability(
            envelope,
            envelope.command as unknown as Readonly<Record<string, unknown>>,
            ownerVaultOpaqueAppendPath,
            authority,
          ).pipe(
            Effect.flatMap((capability) =>
              this.deviceServiceFor(authority, graph.domains, repository).pipe(
                Effect.flatMap((devices) =>
                  devices.verifySignedActorRequest({
                    envelope: envelope.command.envelope,
                    binding: {
                      ownerID: authority.ownerID,
                      vaultID: authority.vaultID,
                      generationEpoch: authority.generationEpoch,
                    },
                    method: "POST",
                    canonicalPath: "/v2/mutations",
                    canonicalQuery: "",
                    bodySHA256: mutationCommandSHA256(envelope.command.command),
                    now: nowMilliseconds,
                  }),
                ),
                Effect.flatMap((actor) => {
                  const fingerprint = ownerVaultOpaqueMutationFingerprint({
                    ownerID: authority.ownerID,
                    vaultID: authority.vaultID,
                    generationEpoch: authority.generationEpoch,
                    operationID: envelope.command.command.operationID,
                    payloadSHA256: envelope.command.command.payloadSHA256,
                    payloadBase64: envelope.command.command.payloadBase64,
                    observedHighWater: envelope.command.command.causalVersion ?? 0,
                  });
                  if (fingerprint === undefined)
                    return Effect.fail(new OwnerVaultDomainError({ reason: "invalid_input" }));
                  return graph.domains
                    .append({
                      operationID: envelope.command.command.operationID,
                      fingerprint,
                      payloadHash: envelope.command.command.payloadSHA256,
                      payloadBase64: envelope.command.command.payloadBase64,
                      source: "http",
                      observedHighWater: envelope.command.command.causalVersion ?? 0,
                      nowSeconds,
                      receiptExpiresAtSeconds: capability.expiresAt,
                      actor: {
                        deviceID: actor.deviceID,
                        authEpoch: actor.authEpoch,
                        credentialEpoch: actor.credentialEpoch,
                        securityFloor: actor.securityFloor,
                      },
                      nonce: {
                        value: envelope.command.envelope.nonce,
                        expiresAtSeconds: Math.floor(envelope.command.envelope.expiresAt / 1_000),
                        fingerprint,
                      },
                      capability: {
                        jti: capability.jti,
                        expiresAtSeconds: capability.expiresAt,
                        resource: ownerVaultOpaqueAppendPath,
                        claims: canonicalCapabilityClaims(
                          capability as unknown as Readonly<Record<string, unknown>>,
                        ),
                        claimsFingerprint: capabilityClaimsFingerprint(
                          capability as unknown as Readonly<Record<string, unknown>>,
                        ),
                        tokenFingerprint: capabilityTokenFingerprint(envelope.capability),
                      },
                    })
                    .pipe(
                      Effect.tap(() => this.scheduleReconciliation(capability.expiresAt * 1_000)),
                    );
                }),
              ),
            ),
            Effect.map((acknowledgement) =>
              response({
                protocolVersion,
                operationID: acknowledgement.operationID,
                logSequence: acknowledgement.logSequence,
              }),
            ),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 403))),
      );

    private prepareSocket = (
      authority: SocketAuthority,
      claims: OwnerVaultSocketAdmissionClaims,
      fingerprint: string,
      bindingNonce: string,
      nowMilliseconds: number,
    ): Effect.Effect<
      { readonly record: SocketAdmissionRecord; readonly creator: boolean },
      SocketStorageFailure
    > => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      if (!socketIdentifier.test(claims.jti) || !socketIdentifier.test(claims.operationID))
        return rejectControl();
      const socketAdmission: SocketAdmissionRecord = {
        phase: "PREPARED",
        ownerID: authority.ownerID,
        vaultID: authority.vaultID,
        generationEpoch: authority.generationEpoch,
        namespaceState: authority.namespaceState,
        routingEpoch: authority.routingEpoch,
        credentialEpoch: authority.credentialEpoch,
        controlEpoch: authority.controlEpoch,
        securityFloor: authority.securityFloor,
        fingerprint,
        jti: claims.jti,
        operationID: claims.operationID,
        deviceID: claims.deviceID,
        sessionID: claims.sessionID,
        upgradeNonce: claims.upgradeNonce,
        bindingNonce,
        challenge: {
          // The server-first challenge is the persistent frame-binding nonce.
          // It is random, scoped to this admission receipt, and survives an
          // early hibernation callback without placing any bearer in storage.
          challengeID: `socket-challenge-${bindingNonce}`,
          challengeBase64: bindingNonce,
          challengeAudience: "owner-vault-socket",
        },
        createdAtMilliseconds: nowMilliseconds,
        acceptedAtMilliseconds: 0,
        issuedAtSeconds: claims.issuedAt,
        expiresAtSeconds: claims.expiresAt,
        expiresAtMilliseconds: claims.expiresAt * 1_000,
        socketGeneration: 1,
        quotaReserved: true,
      };
      if (
        !positive(socketAdmission.expiresAtMilliseconds) ||
        socketAdmission.expiresAtMilliseconds <= nowMilliseconds
      )
        return rejectControl();
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "root.identity" }),
          tx.get({ category: "root.floors" }),
          tx.get({ category: "root.admission" }),
          tx.get({ category: "control.floor-sync", identifier: "authority" }),
          tx.get({ category: "socket.admission", identifier: claims.operationID }),
          tx.get({ category: "socket.jti", identifier: claims.jti }),
        ]).pipe(
          Effect.flatMap(([identity, floors, admission, current, existing, existingJti]) => {
            const root = identity === undefined ? undefined : record(identity.payload);
            const floor = floors === undefined ? undefined : record(floors.payload);
            const counts =
              admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            const currentAuthority = current === undefined ? undefined : record(current.payload);
            if (
              root === undefined ||
              root.ownerID !== authority.ownerID ||
              root.vaultID !== authority.vaultID ||
              root.generationEpoch !== authority.generationEpoch ||
              root.namespaceState !== authority.namespaceState ||
              floor === undefined ||
              floor.securityFloor !== authority.securityFloor ||
              counts === undefined ||
              counts.stopped ||
              currentAuthority === undefined ||
              !samePayload(currentAuthority, {
                kind: "authority",
                credentialEpoch: authority.credentialEpoch,
                routingEpoch: authority.routingEpoch,
                controlEpoch: authority.controlEpoch,
                securityFloor: authority.securityFloor,
              })
            )
              return rejectControl();
            if (existing !== undefined) {
              const stored = socketRecord(existing.payload);
              const jti =
                existingJti === undefined ? undefined : socketJtiRecord(existingJti.payload);
              return stored !== undefined &&
                jti !== undefined &&
                stored.phase !== "EXPIRED" &&
                stored.phase !== "CLOSED" &&
                stored.ownerID === socketAdmission.ownerID &&
                stored.vaultID === socketAdmission.vaultID &&
                stored.generationEpoch === socketAdmission.generationEpoch &&
                stored.namespaceState === socketAdmission.namespaceState &&
                stored.routingEpoch === socketAdmission.routingEpoch &&
                stored.credentialEpoch === socketAdmission.credentialEpoch &&
                stored.controlEpoch === socketAdmission.controlEpoch &&
                stored.securityFloor === socketAdmission.securityFloor &&
                stored.fingerprint === socketAdmission.fingerprint &&
                stored.jti === socketAdmission.jti &&
                stored.deviceID === socketAdmission.deviceID &&
                stored.sessionID === socketAdmission.sessionID &&
                stored.upgradeNonce === socketAdmission.upgradeNonce &&
                stored.issuedAtSeconds === socketAdmission.issuedAtSeconds &&
                stored.expiresAtSeconds === socketAdmission.expiresAtSeconds &&
                stored.expiresAtMilliseconds === socketAdmission.expiresAtMilliseconds &&
                jti.operationID === stored.operationID &&
                jti.fingerprint === stored.fingerprint &&
                jti.expiresAtMilliseconds === stored.expiresAtMilliseconds
                ? Effect.succeed({ record: stored, creator: false })
                : rejectControl();
            }
            if (existingJti !== undefined) return rejectControl();
            if (
              counts.pendingSocketAdmissions + counts.activeSocketAdmissions >=
              ownerVaultMaximumSessions
            )
              return rejectControl();
            if (
              counts.preparedSocketOperationIDs.includes(claims.operationID) ||
              counts.socketReplayJTIs.includes(claims.jti)
            )
              return rejectControl();
            return tx
              .put(
                { category: "socket.admission", identifier: claims.operationID },
                { ...socketAdmission },
              )
              .pipe(
                Effect.zipRight(
                  tx.put(
                    { category: "socket.jti", identifier: claims.jti },
                    {
                      operationID: socketAdmission.operationID,
                      fingerprint: socketAdmission.fingerprint,
                      expiresAtMilliseconds: socketAdmission.expiresAtMilliseconds,
                    },
                  ),
                ),
                Effect.zipRight(
                  tx.put(
                    { category: "root.admission" },
                    {
                      ...counts,
                      pendingSocketAdmissions: counts.pendingSocketAdmissions + 1,
                      preparedSocketOperationIDs: [
                        ...counts.preparedSocketOperationIDs,
                        claims.operationID,
                      ],
                      socketReplayJTIs: [...counts.socketReplayJTIs, claims.jti],
                    },
                  ),
                ),
                Effect.as({ record: socketAdmission, creator: true }),
              );
          }),
        ),
      );
    };

    private acceptSocket = (
      attachment: SocketAttachment,
    ): Effect.Effect<
      { readonly record: SocketAdmissionRecord; readonly accepted: boolean },
      SocketStorageFailure
    > => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const nowMilliseconds = Date.now();
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "socket.admission", identifier: attachment.operationID }),
          tx.get({ category: "root.identity" }),
          tx.get({ category: "root.floors" }),
          tx.get({ category: "root.admission" }),
          tx.get({ category: "control.floor-sync", identifier: "authority" }),
          tx.get({ category: "device", identifier: attachment.deviceID }),
          tx.get({ category: "session", identifier: attachment.sessionID }),
        ]).pipe(
          Effect.flatMap(([stored, identity, floors, admission, current, device, session]) => {
            const prior = stored === undefined ? undefined : socketRecord(stored.payload);
            const root = identity === undefined ? undefined : record(identity.payload);
            const floor = floors === undefined ? undefined : record(floors.payload);
            const counts =
              admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            const authority = current === undefined ? undefined : record(current.payload);
            const persistedDevice =
              device === undefined ? undefined : socketDeviceRecord(device.payload);
            const persistedSession =
              session === undefined ? undefined : socketSessionRecord(session.payload);
            if (
              prior === undefined ||
              root === undefined ||
              floor === undefined ||
              counts === undefined ||
              authority === undefined ||
              persistedDevice === undefined ||
              persistedSession === undefined ||
              counts.stopped ||
              prior.jti !== attachment.jti ||
              prior.bindingNonce !== attachment.bindingNonce ||
              prior.socketGeneration !== attachment.socketGeneration ||
              prior.deviceID !== attachment.deviceID ||
              prior.sessionID !== attachment.sessionID ||
              prior.expiresAtMilliseconds !== attachment.expiresAtMilliseconds ||
              prior.expiresAtMilliseconds <= nowMilliseconds ||
              !samePayload(root, {
                ownerID: prior.ownerID,
                vaultID: prior.vaultID,
                generationEpoch: prior.generationEpoch,
                namespaceState: prior.namespaceState,
              }) ||
              !samePayload(floor, { securityFloor: prior.securityFloor }) ||
              !samePayload(authority, {
                kind: "authority",
                credentialEpoch: prior.credentialEpoch,
                routingEpoch: prior.routingEpoch,
                controlEpoch: prior.controlEpoch,
                securityFloor: prior.securityFloor,
              }) ||
              persistedDevice.deviceID !== prior.deviceID ||
              persistedDevice.revoked ||
              persistedDevice.credentialEpoch !== prior.credentialEpoch ||
              persistedDevice.securityFloor < prior.securityFloor ||
              persistedSession.sessionID !== prior.sessionID ||
              persistedSession.deviceID !== prior.deviceID ||
              persistedSession.authEpoch !== persistedDevice.authEpoch ||
              persistedSession.credentialEpoch !== prior.credentialEpoch ||
              persistedSession.securityFloor < prior.securityFloor ||
              persistedSession.assertionExpiresAtMilliseconds < nowMilliseconds ||
              persistedSession.resumeTokenHash !== prior.fingerprint
            )
              return rejectControl();
            return tx.get({ category: "socket.jti", identifier: prior.jti }).pipe(
              Effect.flatMap(
                (
                  storedJti,
                ): Effect.Effect<
                  { readonly record: SocketAdmissionRecord; readonly accepted: boolean },
                  OwnerVaultStorageTransactionFailure
                > => {
                  const jti =
                    storedJti === undefined ? undefined : socketJtiRecord(storedJti.payload);
                  if (
                    jti === undefined ||
                    jti.operationID !== prior.operationID ||
                    jti.fingerprint !== prior.fingerprint ||
                    jti.expiresAtMilliseconds !== prior.expiresAtMilliseconds ||
                    !counts.socketReplayJTIs.includes(prior.jti)
                  )
                    return rejectControl();
                  if (prior.phase === "ACCEPTED")
                    return Effect.succeed({ record: prior, accepted: false });
                  if (
                    prior.phase !== "PREPARED" ||
                    !prior.quotaReserved ||
                    counts.pendingSocketAdmissions < 1
                  )
                    return rejectControl();
                  const next: SocketAdmissionRecord = {
                    ...prior,
                    phase: "ACCEPTED",
                    acceptedAtMilliseconds: nowMilliseconds,
                    quotaReserved: false,
                  };
                  return tx
                    .put(
                      { category: "socket.admission", identifier: attachment.operationID },
                      { ...next },
                    )
                    .pipe(
                      Effect.zipRight(
                        tx.put(
                          { category: "root.admission" },
                          {
                            ...counts,
                            pendingSocketAdmissions: counts.pendingSocketAdmissions - 1,
                            activeSocketAdmissions: counts.activeSocketAdmissions + 1,
                            preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                              (operationID) => operationID !== attachment.operationID,
                            ),
                          },
                        ),
                      ),
                      Effect.as({ record: next, accepted: true }),
                    );
                },
              ),
            );
          }),
        ),
      );
    };

    private releaseSocket = (
      attachment: SocketAttachment,
    ): Effect.Effect<void, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "socket.admission", identifier: attachment.operationID }),
          tx.get({ category: "root.admission" }),
          tx.get({ category: "session", identifier: attachment.sessionID }),
        ]).pipe(
          Effect.flatMap(([stored, admission, session]) => {
            const prior = stored === undefined ? undefined : socketRecord(stored.payload);
            const counts =
              admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            const persistedSession =
              session === undefined ? undefined : socketSessionRecord(session.payload);
            if (
              prior === undefined ||
              counts === undefined ||
              prior.jti !== attachment.jti ||
              prior.bindingNonce !== attachment.bindingNonce ||
              prior.socketGeneration !== attachment.socketGeneration ||
              prior.deviceID !== attachment.deviceID ||
              prior.sessionID !== attachment.sessionID ||
              prior.expiresAtMilliseconds !== attachment.expiresAtMilliseconds
            )
              return Effect.void;
            const ownedSession =
              persistedSession !== undefined &&
              persistedSession.sessionID === prior.sessionID &&
              persistedSession.deviceID === prior.deviceID &&
              persistedSession.resumeTokenHash === prior.fingerprint;
            const cleanupSession =
              persistedSession !== undefined && ownedSession
                ? tx.delete({ category: "session", identifier: prior.sessionID }).pipe(
                    Effect.zipRight(
                      tx.delete({
                        category: "resume",
                        identifier: persistedSession.resumeTokenHash,
                      }),
                    ),
                    Effect.zipRight(
                      tx.delete({ category: "rate-window", identifier: prior.sessionID }),
                    ),
                  )
                : Effect.void;
            if (prior.phase === "PREPARED" && prior.quotaReserved) {
              if (
                counts.pendingSocketAdmissions < 1 ||
                !counts.preparedSocketOperationIDs.includes(attachment.operationID) ||
                (ownedSession && counts.activeSessions < 1)
              )
                return rejectControl<void>();
              const next: SocketAdmissionRecord = {
                ...prior,
                phase: "EXPIRED",
                quotaReserved: false,
              };
              return tx
                .put(
                  { category: "socket.admission", identifier: attachment.operationID },
                  { ...next },
                )
                .pipe(
                  Effect.zipRight(cleanupSession),
                  Effect.zipRight(
                    tx.put(
                      { category: "root.admission" },
                      {
                        ...counts,
                        pendingSocketAdmissions: counts.pendingSocketAdmissions - 1,
                        activeSessions: ownedSession
                          ? counts.activeSessions - 1
                          : counts.activeSessions,
                        preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                          (operationID) => operationID !== attachment.operationID,
                        ),
                      },
                    ),
                  ),
                );
            }
            if (prior.phase === "ACCEPTED") {
              if (counts.activeSocketAdmissions < 1 || (ownedSession && counts.activeSessions < 1))
                return rejectControl<void>();
              const next: SocketAdmissionRecord = { ...prior, phase: "CLOSED" };
              return tx
                .put(
                  { category: "socket.admission", identifier: attachment.operationID },
                  { ...next },
                )
                .pipe(
                  Effect.zipRight(cleanupSession),
                  Effect.zipRight(
                    tx.put(
                      { category: "root.admission" },
                      {
                        ...counts,
                        activeSocketAdmissions: counts.activeSocketAdmissions - 1,
                        activeSessions: ownedSession
                          ? counts.activeSessions - 1
                          : counts.activeSessions,
                      },
                    ),
                  ),
                );
            }
            return Effect.void;
          }),
        ),
      );
    };

    /** PREPARED records never manufacture a socket after a restart. The JTI
     * index retains exact replay evidence only through signed expiry, then
     * removes socket-owned quota/session state in one DO transaction. */
    private reconcileSocketJTI = (
      jtiID: string,
      nowMilliseconds: number,
    ): Effect.Effect<number | undefined, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "socket.jti", identifier: jtiID }),
          tx.get({ category: "root.admission" }),
        ]).pipe(
          Effect.flatMap(([storedJti, admission]) => {
            const jti = storedJti === undefined ? undefined : socketJtiRecord(storedJti.payload);
            const counts =
              admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            if (counts === undefined) return rejectControl<number | undefined>();
            if (!counts.socketReplayJTIs.includes(jtiID)) return Effect.succeed(undefined);
            if (jti === undefined) return rejectControl<number | undefined>();
            return tx.get({ category: "socket.admission", identifier: jti.operationID }).pipe(
              Effect.flatMap((storedAdmission) => {
                const prior =
                  storedAdmission === undefined ? undefined : socketRecord(storedAdmission.payload);
                if (
                  prior === undefined ||
                  prior.jti !== jtiID ||
                  prior.fingerprint !== jti.fingerprint ||
                  prior.expiresAtMilliseconds !== jti.expiresAtMilliseconds
                )
                  return rejectControl<number | undefined>();
                if (prior.expiresAtMilliseconds > nowMilliseconds)
                  return Effect.succeed(prior.expiresAtMilliseconds);
                return tx.get({ category: "session", identifier: prior.sessionID }).pipe(
                  Effect.flatMap((storedSession) => {
                    const session =
                      storedSession === undefined
                        ? undefined
                        : socketSessionRecord(storedSession.payload);
                    const ownedSession =
                      session !== undefined &&
                      session.deviceID === prior.deviceID &&
                      session.resumeTokenHash === prior.fingerprint;
                    const cleanupSession =
                      session !== undefined && ownedSession
                        ? tx.delete({ category: "session", identifier: prior.sessionID }).pipe(
                            Effect.zipRight(
                              tx.delete({
                                category: "resume",
                                identifier: session.resumeTokenHash,
                              }),
                            ),
                            Effect.zipRight(
                              tx.delete({ category: "rate-window", identifier: prior.sessionID }),
                            ),
                          )
                        : Effect.void;
                    const consumesPending = prior.phase === "PREPARED" && prior.quotaReserved;
                    const consumesActiveSocket = prior.phase === "ACCEPTED";
                    if (
                      (consumesPending &&
                        (counts.pendingSocketAdmissions < 1 ||
                          !counts.preparedSocketOperationIDs.includes(prior.operationID))) ||
                      (consumesActiveSocket && counts.activeSocketAdmissions < 1) ||
                      (ownedSession && counts.activeSessions < 1)
                    )
                      return rejectControl<number | undefined>();
                    return tx
                      .delete({ category: "socket.admission", identifier: prior.operationID })
                      .pipe(
                        Effect.zipRight(tx.delete({ category: "socket.jti", identifier: jtiID })),
                        Effect.zipRight(cleanupSession),
                        Effect.zipRight(
                          tx.put(
                            { category: "root.admission" },
                            {
                              ...counts,
                              pendingSocketAdmissions: consumesPending
                                ? counts.pendingSocketAdmissions - 1
                                : counts.pendingSocketAdmissions,
                              activeSocketAdmissions: consumesActiveSocket
                                ? counts.activeSocketAdmissions - 1
                                : counts.activeSocketAdmissions,
                              activeSessions: ownedSession
                                ? counts.activeSessions - 1
                                : counts.activeSessions,
                              preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                                (operationID) => operationID !== prior.operationID,
                              ),
                              socketReplayJTIs: counts.socketReplayJTIs.filter(
                                (candidate) => candidate !== jtiID,
                              ),
                            },
                          ),
                        ),
                        Effect.as(undefined),
                      );
                  }),
                );
              }),
            );
          }),
        ),
      );
    };

    private reconcileSocketJTIs = (
      nowMilliseconds: number,
    ): Effect.Effect<number | undefined, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository
        .transact((tx) =>
          tx.get({ category: "root.admission" }).pipe(
            Effect.flatMap((admission) => {
              const counts =
                admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
              return counts === undefined
                ? rejectControl<readonly string[]>()
                : Effect.succeed(counts.socketReplayJTIs);
            }),
          ),
        )
        .pipe(
          Effect.flatMap((jtiIDs) =>
            Effect.forEach(jtiIDs, (jtiID) => this.reconcileSocketJTI(jtiID, nowMilliseconds), {
              concurrency: 1,
            }).pipe(
              Effect.map((expiries) =>
                expiries.reduce<number | undefined>(
                  (nearest, expiry) =>
                    expiry === undefined
                      ? nearest
                      : nearest === undefined
                        ? expiry
                        : Math.min(nearest, expiry),
                  undefined,
                ),
              ),
            ),
          ),
        );
    };

    private socketUpgrade = (request: Request): Effect.Effect<Response> => {
      const socketAdmissions = this.socketAdmissions;
      const production = this.production;
      if (socketAdmissions === undefined || production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const url = new URL(request.url);
      const upgrade = request.headers.get("Upgrade");
      const capability = request.headers.get(ownerVaultSocketAdmissionHeader);
      if (
        request.method !== "GET" ||
        url.pathname !== ownerVaultSocketAdmissionPath ||
        url.search !== "" ||
        request.body !== null ||
        upgrade === null ||
        upgrade.toLowerCase() !== "websocket" ||
        upgrade.includes(",") ||
        capability === null ||
        capability.includes(",") ||
        new TextEncoder().encode(`${ownerVaultSocketAdmissionHeader}: ${capability}`).byteLength >
          maximumOwnerVaultSocketAdmissionSerializedHeaderBytes ||
        request.headers.has("Enchiridion-Internal-Capability") ||
        [...request.headers.keys()].some(forbiddenSocketCredential) ||
        (request.headers.get("content-length") !== null &&
          request.headers.get("content-length") !== "0")
      )
        return Effect.succeed(response({ ok: false }, 400));
      const hint = socketHint(capability);
      if (hint === undefined) return Effect.succeed(response({ ok: false }, 401));
      const fingerprint = socketFingerprint(capability);
      return this.socketAuthority().pipe(
        Effect.flatMap((authority) => {
          const binding: OwnerVaultSocketAdmissionRequestBinding = {
            method: "GET",
            path: ownerVaultSocketAdmissionPath,
            canonicalQuery: "",
            bodySHA256: emptyBodySHA256,
            ownerID: hint.ownerID,
            vaultID: hint.vaultID,
            deviceID: hint.deviceID,
            sessionID: hint.sessionID,
            operationID: hint.operationID,
            upgradeNonce: hint.upgradeNonce,
            headerName: ownerVaultSocketAdmissionHeader,
            headerValue: capability,
          };
          return socketAdmissions.verifier
            .verify(
              { value: capability },
              binding,
              {
                ownerID: authority.ownerID,
                vaultID: authority.vaultID,
                generationEpoch: authority.generationEpoch,
                routingEpoch: authority.routingEpoch,
                credentialEpoch: authority.credentialEpoch,
                controlEpoch: authority.controlEpoch,
                securityFloor: authority.securityFloor,
                deviceID: hint.deviceID,
                sessionID: hint.sessionID,
                operationID: hint.operationID,
              },
              now(),
            )
            .pipe(
              Effect.flatMap((claims) => {
                const root = {
                  ownerID: authority.ownerID,
                  vaultID: authority.vaultID,
                  generationEpoch: authority.generationEpoch,
                  namespaceState: authority.namespaceState,
                } as const;
                const graph = makeOwnerVaultProviderGraph(
                  makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage),
                  root,
                  production,
                );
                if (graph === undefined) return rejectControl<Response>();
                return graph.domains.getDevice(claims.deviceID).pipe(
                  Effect.flatMap((device) =>
                    !device.revoked &&
                    device.credentialEpoch === claims.credentialEpoch &&
                    device.securityFloor >= claims.securityFloor
                      ? this.socketNonce()
                      : rejectControl<string>(),
                  ),
                  Effect.flatMap((bindingNonce) =>
                    /^[A-Za-z0-9_-]{22}$/u.test(bindingNonce)
                      ? this.prepareSocket(authority, claims, fingerprint, bindingNonce, Date.now())
                      : rejectControl(),
                  ),
                  Effect.flatMap((prepared) => {
                    if (!prepared.creator) return Effect.succeed(response({ ok: false }, 409));
                    // The PREPARED receipt already owns quota and a JTI. Schedule
                    // its exact expiry before any accept-outside-transaction work
                    // so an isolate loss cannot leave that reservation unbounded.
                    return this.scheduleReconciliation(prepared.record.expiresAtMilliseconds).pipe(
                      Effect.zipRight(graph.domains.getDevice(prepared.record.deviceID)),
                      Effect.flatMap((device) =>
                        graph.domains.establishSession({
                          sessionID: prepared.record.sessionID,
                          deviceID: prepared.record.deviceID,
                          authEpoch: device.authEpoch,
                          credentialEpoch: authority.credentialEpoch,
                          securityFloor: authority.securityFloor,
                          assertionExpiresAtMilliseconds: prepared.record.expiresAtMilliseconds,
                          // The persisted value is only a hash of the signed
                          // capability, never a resume bearer or raw token.
                          resumeTokenHash: prepared.record.fingerprint,
                        }),
                      ),
                      Effect.flatMap(() => {
                        // This retains the PREPARED transaction exactly as an
                        // isolate loss between session establishment and pair
                        // creation would. The durable alarm must release it;
                        // no live socket is manufactured from this state.
                        if (this.socketAdmissionFault === "prepared-loss")
                          return Effect.succeed(response({ ok: false }, 503));
                        const attachment: SocketAttachment = {
                          version: 1,
                          operationID: prepared.record.operationID,
                          jti: prepared.record.jti,
                          sessionID: prepared.record.sessionID,
                          deviceID: prepared.record.deviceID,
                          bindingNonce: prepared.record.bindingNonce,
                          socketGeneration: prepared.record.socketGeneration,
                          expiresAtMilliseconds: prepared.record.expiresAtMilliseconds,
                        };
                        return Effect.try(() => {
                          const pair = new WebSocketPair();
                          const client = pair[0];
                          const server = pair[1];
                          server.serializeAttachment(attachment);
                          if (this.socketAdmissionFault === "accept-failure")
                            throw new Error("workerd socket acceptance fault");
                          this.ctx.acceptWebSocket(server);
                          return { client, server };
                        }).pipe(
                          // A WebSocketPair or acceptWebSocket failure is a
                          // transport failure, not an authorization failure.
                          // Convert it to the bounded cleanup branch below.
                          Effect.catchAll(() => Effect.succeed(undefined)),
                          Effect.flatMap((socket) =>
                            socket === undefined
                              ? this.releaseSocket(attachment).pipe(
                                  Effect.catchAll(() => Effect.void),
                                  Effect.as(response({ ok: false }, 503)),
                                )
                              : this.socketAdmissionFault === "finalize-loss"
                                ? this.releaseSocket(attachment).pipe(
                                    Effect.catchAll(() => Effect.void),
                                    Effect.tap(() =>
                                      Effect.sync(() =>
                                        socket.server.close(4401, "socket admission lost"),
                                      ),
                                    ),
                                    Effect.as(response({ ok: false }, 503)),
                                  )
                                : (this.socketAdmissionFault === "early-callback"
                                    ? this.socketMessage(
                                        socket.server,
                                        "discarded early callback",
                                      ).pipe(Effect.zipRight(this.acceptSocket(attachment)))
                                    : this.acceptSocket(attachment)
                                  ).pipe(
                                    Effect.tap((accepted) =>
                                      Effect.sync(() => {
                                        if (accepted.accepted)
                                          socket.server.send(
                                            JSON.stringify(accepted.record.challenge),
                                          );
                                      }),
                                    ),
                                    Effect.tap(() =>
                                      this.scheduleReconciliation(attachment.expiresAtMilliseconds),
                                    ),
                                    Effect.map(
                                      () =>
                                        new Response(null, {
                                          status: 101,
                                          webSocket: socket.client,
                                        }),
                                    ),
                                    Effect.catchAll(() =>
                                      this.releaseSocket(attachment).pipe(
                                        Effect.catchAll(() => Effect.void),
                                        Effect.as(response({ ok: false }, 503)),
                                        Effect.tap(() =>
                                          Effect.sync(() =>
                                            socket.server.close(4401, "socket admission failed"),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                          ),
                        );
                      }),
                    );
                  }),
                );
              }),
            );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 401))),
      );
    };

    private revalidateSocket = (
      attachment: SocketAttachment,
    ): Effect.Effect<SocketAdmissionRecord, SocketStorageFailure> =>
      this.socketAuthority().pipe(
        Effect.flatMap((authority): Effect.Effect<SocketAdmissionRecord, SocketStorageFailure> => {
          if (authority.admission.stopped) return rejectControl<SocketAdmissionRecord>();
          const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
          const root = {
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
            generationEpoch: authority.generationEpoch,
            namespaceState: authority.namespaceState,
          } as const;
          const graph =
            this.production === undefined
              ? undefined
              : makeOwnerVaultProviderGraph(repository, root, this.production);
          if (graph === undefined) return rejectControl<SocketAdmissionRecord>();
          const nowMilliseconds = Date.now();
          return repository
            .transact((tx) =>
              Effect.all([
                tx.get({ category: "root.identity" }),
                tx.get({ category: "root.floors" }),
                tx.get({ category: "root.admission" }),
                tx.get({ category: "control.floor-sync", identifier: "authority" }),
                tx.get({ category: "socket.admission", identifier: attachment.operationID }),
                tx.get({ category: "socket.jti", identifier: attachment.jti }),
                tx.get({ category: "device", identifier: attachment.deviceID }),
                tx.get({ category: "session", identifier: attachment.sessionID }),
              ]).pipe(
                Effect.flatMap(
                  ([
                    identity,
                    floors,
                    admission,
                    current,
                    storedSocket,
                    storedJti,
                    storedDevice,
                    storedSession,
                  ]): Effect.Effect<SocketAdmissionRecord, OwnerVaultStorageTransactionFailure> => {
                    const durableRoot =
                      identity === undefined ? undefined : record(identity.payload);
                    const durableFloors = floors === undefined ? undefined : record(floors.payload);
                    const counts =
                      admission === undefined
                        ? undefined
                        : socketAdmissionCounts(admission.payload);
                    const durableAuthority =
                      current === undefined ? undefined : record(current.payload);
                    const socket =
                      storedSocket === undefined ? undefined : socketRecord(storedSocket.payload);
                    const jti =
                      storedJti === undefined ? undefined : socketJtiRecord(storedJti.payload);
                    const device =
                      storedDevice === undefined
                        ? undefined
                        : socketDeviceRecord(storedDevice.payload);
                    const session =
                      storedSession === undefined
                        ? undefined
                        : socketSessionRecord(storedSession.payload);
                    if (
                      durableRoot === undefined ||
                      durableFloors === undefined ||
                      counts === undefined ||
                      durableAuthority === undefined ||
                      socket === undefined ||
                      jti === undefined ||
                      device === undefined ||
                      session === undefined ||
                      counts.stopped ||
                      !samePayload(durableRoot, root) ||
                      !samePayload(durableFloors, { securityFloor: authority.securityFloor }) ||
                      !samePayload(durableAuthority, {
                        kind: "authority",
                        credentialEpoch: authority.credentialEpoch,
                        routingEpoch: authority.routingEpoch,
                        controlEpoch: authority.controlEpoch,
                        securityFloor: authority.securityFloor,
                      }) ||
                      socket.phase !== "ACCEPTED" ||
                      socket.ownerID !== authority.ownerID ||
                      socket.vaultID !== authority.vaultID ||
                      socket.generationEpoch !== authority.generationEpoch ||
                      socket.namespaceState !== authority.namespaceState ||
                      socket.routingEpoch !== authority.routingEpoch ||
                      socket.credentialEpoch !== authority.credentialEpoch ||
                      socket.controlEpoch !== authority.controlEpoch ||
                      socket.securityFloor !== authority.securityFloor ||
                      socket.jti !== attachment.jti ||
                      socket.bindingNonce !== attachment.bindingNonce ||
                      socket.socketGeneration !== attachment.socketGeneration ||
                      socket.sessionID !== attachment.sessionID ||
                      socket.deviceID !== attachment.deviceID ||
                      socket.expiresAtMilliseconds !== attachment.expiresAtMilliseconds ||
                      socket.expiresAtMilliseconds <= nowMilliseconds ||
                      jti.operationID !== socket.operationID ||
                      jti.fingerprint !== socket.fingerprint ||
                      jti.expiresAtMilliseconds !== socket.expiresAtMilliseconds ||
                      !counts.socketReplayJTIs.includes(socket.jti) ||
                      device.deviceID !== socket.deviceID ||
                      device.revoked ||
                      device.credentialEpoch !== socket.credentialEpoch ||
                      device.securityFloor < socket.securityFloor ||
                      session.sessionID !== socket.sessionID ||
                      session.deviceID !== socket.deviceID ||
                      session.authEpoch !== device.authEpoch ||
                      session.credentialEpoch !== socket.credentialEpoch ||
                      session.securityFloor < socket.securityFloor ||
                      session.assertionExpiresAtMilliseconds !== socket.expiresAtMilliseconds ||
                      session.assertionExpiresAtMilliseconds <= nowMilliseconds ||
                      session.resumeTokenHash !== socket.fingerprint
                    )
                      return rejectControl<SocketAdmissionRecord>();
                    return Effect.succeed(socket);
                  },
                ),
              ),
            )
            .pipe(
              Effect.flatMap((socket) =>
                graph.domains
                  .consumeRate({
                    sessionID: attachment.sessionID,
                    nowMilliseconds,
                    maximumFramesPerMinute: socketMaximumFramesPerMinute,
                  })
                  .pipe(
                    Effect.catchAll(() => rejectControl<void>()),
                    Effect.as(socket),
                  ),
              ),
              Effect.catchAll(
                (): Effect.Effect<SocketAdmissionRecord, SocketStorageFailure> =>
                  rejectControl<SocketAdmissionRecord>(),
              ),
            );
        }),
      );

    /** Typed P02 sync-frame admission for an already ACCEPTED socket. The
     * durable append call owns nonce/JTI/receipt/log atomicity; callback state
     * is reloaded before every frame and never trusted from the attachment. */
    private applySocketSyncChange = (
      socket: WebSocket,
      attachment: SocketAttachment,
      admission: SocketAdmissionRecord,
      message: string | ArrayBuffer,
    ): Effect.Effect<void, unknown> => {
      const production = this.production;
      const storage = this.boundary.storage;
      return Effect.gen(function* () {
        const frame = yield* decodeOwnerVaultClientFrame(message, maximumBodyBytes).pipe(
          Effect.mapError((error): unknown => error),
        );
        if (frame.type !== "syncChange") return yield* rejectControl<void>();
        if (
          frame.vaultID !== admission.vaultID ||
          frame.deviceID !== admission.deviceID ||
          frame.authEpoch < 1 ||
          frame.credentialEpoch !== admission.credentialEpoch ||
          frame.generationEpoch !== admission.generationEpoch ||
          frame.sessionNonce !== admission.bindingNonce ||
          frame.assertionExpiresAt !== admission.expiresAtMilliseconds
        )
          return yield* rejectControl<void>();
        const root = {
          ownerID: admission.ownerID,
          vaultID: admission.vaultID,
          generationEpoch: admission.generationEpoch,
          namespaceState: admission.namespaceState,
        } as const;
        if (production === undefined) return yield* rejectControl<void>();
        const graph = makeOwnerVaultProviderGraph(
          makeDurableObjectOwnerVaultStorageRepository(storage),
          root,
          production,
        );
        if (graph === undefined) return yield* rejectControl<void>();
        const device = yield* graph.domains
          .getDevice(frame.deviceID)
          .pipe(Effect.mapError((error): unknown => error));
        const spki = base64Bytes(device.publicKeySPKI);
        const signature = base64Bytes(frame.deviceSignature);
        const payload = syncChangeSigningPayload(frame);
        if (
          spki === undefined ||
          signature === undefined ||
          device.revoked ||
          device.authEpoch !== frame.authEpoch ||
          device.credentialEpoch !== admission.credentialEpoch ||
          device.securityFloor < admission.securityFloor
        )
          return yield* rejectControl<void>();
        yield* makeP256Crypto()
          .verify({
            spkiDER: spki,
            message: payload,
            signatureDER: signature,
          })
          .pipe(Effect.mapError((error): unknown => error));
        const receiptJTI = sha256Hex(
          new TextEncoder().encode(
            `owner-vault-socket-sync\u0000${admission.jti}\u0000${frame.frameID}`,
          ),
        );
        const receiptClaims = {
          ownerID: admission.ownerID,
          vaultID: admission.vaultID,
          generationEpoch: admission.generationEpoch,
          routingEpoch: admission.routingEpoch,
          credentialEpoch: admission.credentialEpoch,
          controlEpoch: admission.controlEpoch,
          securityFloor: admission.securityFloor,
          deviceID: admission.deviceID,
          sessionID: admission.sessionID,
          operationID: frame.operationID,
          jti: receiptJTI,
          socketAdmissionJTI: admission.jti,
          frameID: frame.frameID,
          issuedAt: admission.issuedAtSeconds,
          expiresAt: admission.expiresAtSeconds,
        } as const;
        const acknowledgement = yield* graph.domains
          .append({
            operationID: frame.operationID,
            fingerprint:
              ownerVaultOpaqueMutationFingerprint({
                ownerID: admission.ownerID,
                vaultID: admission.vaultID,
                generationEpoch: admission.generationEpoch,
                operationID: frame.operationID,
                payloadSHA256: frame.payloadSHA256,
                payloadBase64: frame.payloadBase64,
                observedHighWater: frame.observedHighWater,
              }) ?? (yield* rejectControl<string>()),
            payloadHash: frame.payloadSHA256,
            payloadBase64: frame.payloadBase64,
            source: "websocket",
            observedHighWater: frame.observedHighWater,
            nowSeconds: now(),
            receiptExpiresAtSeconds: admission.expiresAtSeconds,
            actor: {
              deviceID: device.deviceID,
              authEpoch: device.authEpoch,
              credentialEpoch: device.credentialEpoch,
              securityFloor: device.securityFloor,
            },
            nonce: {
              value: frame.frameID,
              expiresAtSeconds: admission.expiresAtSeconds,
              fingerprint: sha256Hex(payload),
            },
            capability: {
              jti: receiptJTI,
              expiresAtSeconds: admission.expiresAtSeconds,
              resource: "/v2/sync",
              claims: canonicalCapabilityClaims(receiptClaims),
              claimsFingerprint: capabilityClaimsFingerprint(receiptClaims),
              tokenFingerprint: admission.fingerprint,
            },
          })
          .pipe(Effect.mapError((error): unknown => error));
        socket.send(
          JSON.stringify({
            type: "syncAcknowledged",
            protocolVersion,
            vaultID: admission.vaultID,
            operationID: acknowledgement.operationID,
            logSequence: acknowledgement.logSequence,
          }),
        );
      });
    };

    private socketMessage = (
      socket: WebSocket,
      message: string | ArrayBuffer,
    ): Effect.Effect<void> => {
      const attachment = validSocketAttachment(socket.deserializeAttachment())
        ? (socket.deserializeAttachment() as SocketAttachment)
        : undefined;
      if (
        attachment === undefined ||
        JSON.stringify(attachment).length > socketAttachmentMaximumBytes
      )
        return Effect.sync(() => socket.close(4400, "invalid socket attachment"));
      return this.acceptSocket(attachment).pipe(
        Effect.flatMap((accepted) =>
          accepted.accepted
            ? Effect.sync(() => socket.send(JSON.stringify(accepted.record.challenge)))
            : this.revalidateSocket(attachment).pipe(
                Effect.flatMap((admission) =>
                  this.applySocketSyncChange(socket, attachment, admission, message),
                ),
              ),
        ),
        // The frame that races acceptance is deliberately discarded. Every
        // later callback runs through the typed P02 sync decoder above.
        Effect.asVoid,
        Effect.catchAll(() => Effect.sync(() => socket.close(4401, "socket authorization failed"))),
      );
    };

    private readonly effectHandler = (request: Request): Effect.Effect<Response> =>
      Effect.try({
        try: () => ({ method: request.method, pathname: new URL(request.url).pathname }),
        catch: () => undefined,
      }).pipe(
        Effect.flatMap((route) => {
          if (route?.method === "GET" && route.pathname === ownerVaultSocketAdmissionPath)
            return this.socketUpgrade(request);
          if (route?.method !== "POST") return Effect.succeed(response({ ok: false }, 404));
          const ovdc =
            route.pathname === ownerVaultPrivateInitializePath ||
            route.pathname === ownerVaultCredentialFencePath ||
            route.pathname === ownerVaultSnapshotPath ||
            route.pathname === ownerVaultRestorePath;
          return readBoundedRequestBody(request, {
            maximumBytes:
              route.pathname === ownerVaultOpaqueAppendPath
                ? ownerVaultAppendMaximumBodyBytes
                : ovdc
                  ? controlMaximumBodyBytes
                  : maximumBodyBytes,
            requiredContentType: "application/json",
          }).pipe(
            Effect.flatMap((bytes) => {
              if (route.pathname === ownerVaultPrivateInitializePath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validPrivateInitialize);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.privateInitialize(envelope);
              }
              if (route.pathname === ownerVaultCredentialFencePath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validFence);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.credentialFence(envelope);
              }
              if (route.pathname === ownerVaultSnapshotPath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validSnapshot);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.snapshot(envelope);
              }
              if (route.pathname === ownerVaultRestorePath) {
                const envelope = decodeOwnerVaultControlEnvelope(bytes, validRestore);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.restore(envelope);
              }
              if (route.pathname === ownerVaultDeviceChallengePath) {
                const envelope = decodeOwnerVaultUserEnvelope(bytes, decodeDeviceChallengeRequest);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.deviceChallenge(envelope);
              }
              if (route.pathname === ownerVaultDeviceCompletePath) {
                const envelope = decodeOwnerVaultUserEnvelope(bytes, decodeDeviceRegisterRequest);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.deviceComplete(envelope);
              }
              if (route.pathname === ownerVaultOpaqueAppendPath) {
                const envelope = decodeOwnerVaultUserEnvelope(bytes, decodeMutationRequest);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.opaqueAppend(envelope);
              }
              if (route.pathname === ownerVaultInitializationPath) {
                const envelope = decodeEnvelope(bytes, validOwnerVaultInitializationCommand);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.initialize(envelope);
              }
              if (route.pathname === ownerVaultFloorSyncPath) {
                const envelope = decodeEnvelope(bytes, validOwnerVaultFloorSyncCommand);
                return envelope === undefined
                  ? Effect.succeed(response({ ok: false }, 400))
                  : this.syncFloors(envelope);
              }
              return Effect.succeed(response({ ok: false }, 404));
            }),
          );
        }),
        Effect.catchAll(() => Effect.succeed(response({ ok: false }, 400))),
      );
    override readonly fetch = (request: Request): Promise<Response> =>
      this.boundary.callbacks.fetch(this.effectHandler(request));
    override readonly webSocketMessage = (
      socket: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> =>
      this.boundary.callbacks.webSocketMessage(this.socketMessage(socket, message));
    override readonly webSocketClose = (socket: WebSocket): Promise<void> => {
      const candidate = socket.deserializeAttachment();
      const attachment = validSocketAttachment(candidate) ? candidate : undefined;
      return attachment === undefined
        ? Promise.resolve()
        : this.boundary.callbacks.webSocketMessage(
            this.releaseSocket(attachment).pipe(Effect.catchAll(() => Effect.void)),
          );
    };
    override readonly webSocketError = (socket: WebSocket, _error: unknown): Promise<void> => {
      const candidate = socket.deserializeAttachment();
      const attachment = validSocketAttachment(candidate) ? candidate : undefined;
      return attachment === undefined
        ? Promise.resolve()
        : this.boundary.callbacks.webSocketMessage(
            this.releaseSocket(attachment).pipe(Effect.catchAll(() => Effect.void)),
          );
    };
    override readonly alarm = (): Promise<void> =>
      this.boundary.callbacks.alarm(
        Effect.gen(this, function* () {
          let nearest: number | undefined;
          const nowMilliseconds = Date.now();
          for (const socket of this.ctx.getWebSockets()) {
            const candidate = socket.deserializeAttachment();
            const attachment = validSocketAttachment(candidate) ? candidate : undefined;
            if (attachment === undefined) {
              socket.close(4400, "invalid socket attachment");
              continue;
            }
            if (attachment.expiresAtMilliseconds <= nowMilliseconds) {
              yield* this.releaseSocket(attachment).pipe(Effect.catchAll(() => Effect.void));
              socket.close(4408, "socket expired");
              continue;
            }
            const accepted = yield* this.acceptSocket(attachment).pipe(Effect.either);
            if (accepted._tag === "Left") {
              yield* this.releaseSocket(attachment).pipe(Effect.catchAll(() => Effect.void));
              socket.close(4401, "socket authorization failed");
              continue;
            }
            if (accepted.right.accepted)
              socket.send(JSON.stringify(accepted.right.record.challenge));
            nearest =
              nearest === undefined
                ? attachment.expiresAtMilliseconds
                : Math.min(nearest, attachment.expiresAtMilliseconds);
          }
          const preparedNearest = yield* this.reconcileSocketJTIs(nowMilliseconds).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
          );
          if (preparedNearest !== undefined)
            nearest = nearest === undefined ? preparedNearest : Math.min(nearest, preparedNearest);
          const capabilityNearest = yield* this.reconcileCapabilityReceipts(
            Math.floor(nowMilliseconds / 1_000),
          ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
          if (capabilityNearest !== undefined) {
            const capabilityAt = capabilityNearest * 1_000;
            nearest = nearest === undefined ? capabilityAt : Math.min(nearest, capabilityAt);
          }
          if (nearest === undefined) yield* this.boundary.storage.deleteAlarm();
          else yield* this.boundary.storage.setAlarm(nearest);
        }),
      );
  }
  return OwnerVaultV2;
};
