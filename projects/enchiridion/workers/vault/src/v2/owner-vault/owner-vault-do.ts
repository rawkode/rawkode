import { DurableObject } from "cloudflare:workers";
/** @enchiridion/effect-module */
import { parseJSONWithoutDuplicateMembers, sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  DirectoryControlResource,
  OwnerVaultDirectoryControlResource,
  ownerVaultSocketAdmissionHeader,
  type OwnerVaultSocketAdmissionClaims,
  type OwnerVaultSocketAdmissionRequestBinding,
  type SignedCapability,
  type SignedOwnerVaultDirectoryControl,
  makeDurableObjectBoundary,
  ownerVaultCredentialFencePath,
  ownerVaultPrivateInitializePath,
  ownerVaultRestorePath,
  ownerVaultSnapshotPath,
  readBoundedRequestBody,
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
import type { DirectoryControlCapabilityFactory } from "../foundation/crypto";
import { restoreOwnerVaultBackup } from "./backup";
import { OwnerVaultBackupError } from "./backup-types";
import { makeOwnerVaultDomainProvider, ownerVaultMaximumSessions } from "./domains";
import { makeOwnerVaultProviderGraph } from "./provider-graph";
import {
  type OwnerVaultStorageTransactionFailure,
  type OwnerVaultStorageRepositoryError,
  makeDurableObjectOwnerVaultStorageRepository,
} from "./repository";

const maximumBodyBytes = 16_384;
const controlMaximumBodyBytes = 32_768;
export const ownerVaultInternalSocketPath = "/__v2/internal/owner-vault/socket";
const emptyBodySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const maximumSocketCapabilityBytes = 8_192;
const socketAttachmentMaximumBytes = 1_024;
const socketPrepareTTLMilliseconds = 60_000;
const socketMaximumFramesPerMinute = 120;
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
  readonly fingerprint: string;
  readonly jti: string;
  readonly operationID: string;
  readonly deviceID: string;
  readonly sessionID: string;
  readonly bindingNonce: string;
  readonly challenge: { readonly challengeID: string; readonly challengeBase64: string; readonly challengeAudience: "owner-vault-socket" };
  readonly createdAtMilliseconds: number;
  readonly expiresAtMilliseconds: number;
  readonly socketGeneration: number;
  readonly quotaReserved: boolean;
}
interface SocketAttachment {
  readonly version: 1;
  readonly operationID: string;
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
  } catch { return undefined; }
};
const socketHint = (capability: string): SocketCapabilityHint | undefined => {
  const parts = capability.split(".");
  if (parts.length !== 3 || parts[0] !== "ovsa1" || parts[1] === undefined) return undefined;
  const bytes = base64urlBytes(parts[1]);
  if (bytes === undefined) return undefined;
  try {
    const payload = record(parseJSONWithoutDuplicateMembers(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (payload === undefined ||
      typeof payload.ownerID !== "string" || typeof payload.vaultID !== "string" ||
      typeof payload.deviceID !== "string" || typeof payload.sessionID !== "string" ||
      typeof payload.operationID !== "string" || typeof payload.upgradeNonce !== "string" ||
      !opaqueID.test(payload.ownerID) || !opaqueID.test(payload.vaultID) || payload.ownerID === payload.vaultID ||
      !opaqueID.test(payload.deviceID) || !opaqueID.test(payload.sessionID) ||
      !opaqueOperationID.test(payload.operationID) || !/^[A-Za-z0-9_-]{22,128}$/u.test(payload.upgradeNonce)
    ) return undefined;
    return { ownerID: payload.ownerID, vaultID: payload.vaultID, deviceID: payload.deviceID, sessionID: payload.sessionID, operationID: payload.operationID, upgradeNonce: payload.upgradeNonce };
  } catch { return undefined; }
};
const socketFingerprint = (capability: string): string => sha256Hex(new TextEncoder().encode(capability));
const validSocketAttachment = (value: unknown): value is SocketAttachment => {
  const source = record(value);
  return source !== undefined && exact(source, ["version", "operationID", "sessionID", "deviceID", "bindingNonce", "socketGeneration", "expiresAtMilliseconds"]) &&
    source.version === 1 && typeof source.operationID === "string" && opaqueOperationID.test(source.operationID) &&
    typeof source.sessionID === "string" && opaqueID.test(source.sessionID) && typeof source.deviceID === "string" && opaqueID.test(source.deviceID) &&
    typeof source.bindingNonce === "string" && /^[A-Za-z0-9_-]{22,128}$/u.test(source.bindingNonce) &&
    positive(source.socketGeneration) && typeof source.expiresAtMilliseconds === "number" && Number.isSafeInteger(source.expiresAtMilliseconds) && source.expiresAtMilliseconds > 0;
};
const socketRecord = (value: unknown): SocketAdmissionRecord | undefined => {
  const source = record(value); const challenge = source === undefined ? undefined : record(source.challenge);
  return source !== undefined && challenge !== undefined && exact(source, ["bindingNonce", "challenge", "createdAtMilliseconds", "deviceID", "expiresAtMilliseconds", "fingerprint", "jti", "operationID", "phase", "quotaReserved", "sessionID", "socketGeneration"]) &&
    (source.phase === "PREPARED" || source.phase === "ACCEPTED" || source.phase === "EXPIRED" || source.phase === "CLOSED") &&
    typeof source.fingerprint === "string" && hexDigest.test(source.fingerprint) && typeof source.jti === "string" && opaqueOperationID.test(source.jti) &&
    typeof source.operationID === "string" && opaqueOperationID.test(source.operationID) && typeof source.deviceID === "string" && opaqueID.test(source.deviceID) &&
    typeof source.sessionID === "string" && opaqueID.test(source.sessionID) && typeof source.bindingNonce === "string" && /^[A-Za-z0-9_-]{22,128}$/u.test(source.bindingNonce) &&
    typeof source.createdAtMilliseconds === "number" && Number.isSafeInteger(source.createdAtMilliseconds) && source.createdAtMilliseconds >= 0 &&
    typeof source.expiresAtMilliseconds === "number" && Number.isSafeInteger(source.expiresAtMilliseconds) && source.expiresAtMilliseconds > source.createdAtMilliseconds &&
    positive(source.socketGeneration) && typeof source.quotaReserved === "boolean" &&
    exact(challenge, ["challengeID", "challengeBase64", "challengeAudience"]) && typeof challenge.challengeID === "string" && opaqueID.test(challenge.challengeID) &&
    typeof challenge.challengeBase64 === "string" && /^[A-Za-z0-9_-]{22,128}$/u.test(challenge.challengeBase64) && challenge.challengeAudience === "owner-vault-socket"
    ? { phase: source.phase, fingerprint: source.fingerprint, jti: source.jti, operationID: source.operationID, deviceID: source.deviceID, sessionID: source.sessionID, bindingNonce: source.bindingNonce, challenge: { challengeID: challenge.challengeID, challengeBase64: challenge.challengeBase64, challengeAudience: "owner-vault-socket" }, createdAtMilliseconds: source.createdAtMilliseconds, expiresAtMilliseconds: source.expiresAtMilliseconds, socketGeneration: source.socketGeneration, quotaReserved: source.quotaReserved }
    : undefined;
};
const forbiddenSocketCredential = (name: string): boolean => {
  const normalized = name.toLowerCase();
  return normalized === "authorization" || normalized === "cookie" || normalized === "proxy-authorization" ||
    normalized.startsWith("cf-access-");
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
}
const socketAdmissionCounts = (value: unknown): SocketAdmissionCounts | undefined => {
  const source = record(value);
  if (source === undefined ||
    !(exact(source, ["activeChallenges", "activeDevices", "activeSessions", "capabilityReceipts"]) ||
      exact(source, ["activeChallenges", "activeDevices", "activeSessions", "capabilityReceipts", "stopped"]) ||
      exact(source, ["activeChallenges", "activeDevices", "activeSessions", "capabilityReceipts", "stopped", "pendingSocketAdmissions", "activeSocketAdmissions"]) ||
      exact(source, ["activeChallenges", "activeDevices", "activeSessions", "capabilityReceipts", "stopped", "pendingSocketAdmissions", "activeSocketAdmissions", "preparedSocketOperationIDs"]))) return undefined;
  const counts = [source.activeChallenges, source.activeDevices, source.activeSessions, source.capabilityReceipts, source.pendingSocketAdmissions ?? 0, source.activeSocketAdmissions ?? 0];
  const prepared = source.preparedSocketOperationIDs ?? [];
  return counts.every(nonNegative) && (source.stopped === undefined || typeof source.stopped === "boolean") &&
    Array.isArray(prepared) && prepared.length <= ownerVaultMaximumSessions &&
    prepared.every((operationID) => typeof operationID === "string" && opaqueOperationID.test(operationID)) &&
    new Set(prepared).size === prepared.length
    ? { activeChallenges: source.activeChallenges as number, activeDevices: source.activeDevices as number, activeSessions: source.activeSessions as number, capabilityReceipts: source.capabilityReceipts as number, stopped: source.stopped === true, pendingSocketAdmissions: (source.pendingSocketAdmissions ?? 0) as number, activeSocketAdmissions: (source.activeSocketAdmissions ?? 0) as number, preparedSocketOperationIDs: prepared as readonly string[] }
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
type SocketStorageFailure =
  | OwnerVaultStorageTransactionFailure
  | OwnerVaultStorageRepositoryError;

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
  hexDigest.test(value.manifestDigest);
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
  hexDigest.test(value.manifestDigest);

export interface OwnerVaultDODependencies {
  readonly controls: DirectoryControlCapabilityFactory;
  /** ovdc1 is deliberately distinct from the historical Directory capability. */
  readonly ownerVaultControls?: OwnerVaultDirectoryControlFactory;
  /** The only configuration authority supplied to P02/P03/C2/C4 providers. */
  readonly production?: OwnerVaultProductionAuthority;
  /** Dedicated ovsa1 ring; it is never substituted with Directory authority. */
  readonly socketAdmissions?: OwnerVaultSocketAdmissionFactory;
  /** Injected only for deterministic Workerd fault/race tests; production uses Web Crypto. */
  readonly socketNonce?: () => Effect.Effect<string>;
}
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
    private readonly ownerVaultControls: OwnerVaultDirectoryControlFactory | undefined;
    private readonly production: OwnerVaultProductionAuthority | undefined;
    private readonly socketAdmissions: OwnerVaultSocketAdmissionFactory | undefined;
    private readonly socketNonce: () => Effect.Effect<string>;
    constructor(ctx: DurableObjectState, env: Readonly<Record<never, never>>) {
      super(ctx, env);
      const resolved = typeof dependencies === "function" ? dependencies(env) : dependencies;
      this.controls = resolved?.controls;
      this.ownerVaultControls = resolved?.ownerVaultControls;
      this.production = resolved?.production;
      this.socketAdmissions = resolved?.socketAdmissions;
      this.socketNonce = resolved?.socketNonce ?? (() => Effect.sync(() => {
        const bytes = new Uint8Array(32);
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
      } as const;
      if (this.controls === undefined) return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return this.controls.verifier.verify(envelope.capability, binding, expected, now()).pipe(
        Effect.flatMap(() => {
          const provider = makeOwnerVaultDomainProvider(repository, commandIdentity(command));
          const payload = initPayload(
            command,
            durableReceipt("init", command.operationID, command.initDigest),
          );
          return provider.initialize().pipe(
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
      } as const;
      if (this.controls === undefined) return Effect.succeed(response({ ok: false }, 503));
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return this.controls.verifier.verify(envelope.capability, binding, expected, now()).pipe(
        Effect.flatMap(() =>
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
        Effect.flatMap(() => graph.domains.initialize()),
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
                      .put({ category: "root.floors" }, { securityFloor: command.securityFloor })
                      .pipe(
                        Effect.zipRight(
                          tx.put(
                            { category: "control.initialization-ack", identifier: command.initID },
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
        Effect.flatMap(() =>
          repository.transact((tx) =>
            tx.get({ category: "control.floor-sync", identifier: command.operationID }).pipe(
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
                    const root = identity === undefined ? undefined : record(identity.payload);
                    const currentFloors = floors === undefined ? undefined : record(floors.payload);
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
                      !exact(root, ["ownerID", "vaultID", "generationEpoch", "namespaceState"]) ||
                      root.ownerID !== command.ownerID ||
                      root.vaultID !== command.vaultID ||
                      root.generationEpoch !== command.generationEpoch ||
                      (root.namespaceState !== "PRIVATE" && root.namespaceState !== "ACTIVE") ||
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
                        { category: "control.floor-sync", identifier: command.operationID },
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
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap(() =>
          graph.snapshots.beginSnapshot(
            {
              ownerID: command.ownerID,
              vaultID: command.vaultID,
              generationEpoch: command.sourceGeneration,
            },
            command.backupID,
          ),
        ),
        Effect.map((pin): Response => response({ pin })),
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
      return this.ownerVaultControls.verify(envelope.capability, binding, binding, now()).pipe(
        Effect.flatMap(() => graph.backupRuntime()),
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
          ),
        ),
        Effect.as(
          response({
            ok: true,
            backupID: command.backupID,
            targetGeneration: command.targetGeneration,
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
            const counts = admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
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
              !exact(current, ["kind", "credentialEpoch", "routingEpoch", "controlEpoch", "securityFloor"]) ||
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

    private prepareSocket = (
      authority: SocketAuthority,
      claims: OwnerVaultSocketAdmissionClaims,
      fingerprint: string,
      bindingNonce: string,
      challengeNonce: string,
      nowMilliseconds: number,
    ): Effect.Effect<{ readonly record: SocketAdmissionRecord; readonly creator: boolean }, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      const socketAdmission: SocketAdmissionRecord = {
        phase: "PREPARED",
        fingerprint,
        jti: claims.jti,
        operationID: claims.operationID,
        deviceID: claims.deviceID,
        sessionID: claims.sessionID,
        bindingNonce,
        challenge: {
          challengeID: `socket-challenge-${challengeNonce}`,
          challengeBase64: challengeNonce,
          challengeAudience: "owner-vault-socket",
        },
        createdAtMilliseconds: nowMilliseconds,
        expiresAtMilliseconds: Math.min(claims.expiresAt * 1_000, nowMilliseconds + socketPrepareTTLMilliseconds),
        socketGeneration: 1,
        quotaReserved: true,
      };
      if (!positive(socketAdmission.expiresAtMilliseconds) || socketAdmission.expiresAtMilliseconds <= nowMilliseconds)
        return rejectControl();
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "root.identity" }),
          tx.get({ category: "root.floors" }),
          tx.get({ category: "root.admission" }),
          tx.get({ category: "control.floor-sync", identifier: "authority" }),
          tx.get({ category: "socket.admission", identifier: claims.operationID }),
        ]).pipe(
          Effect.flatMap(([identity, floors, admission, current, existing]) => {
            const root = identity === undefined ? undefined : record(identity.payload);
            const floor = floors === undefined ? undefined : record(floors.payload);
            const counts = admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            const currentAuthority = current === undefined ? undefined : record(current.payload);
            if (
              root === undefined ||
              root.ownerID !== authority.ownerID ||
              root.vaultID !== authority.vaultID ||
              root.generationEpoch !== authority.generationEpoch ||
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
            ) return rejectControl();
            if (existing !== undefined) {
              const stored = socketRecord(existing.payload);
              return stored !== undefined && stored.fingerprint === fingerprint && stored.jti === claims.jti &&
                stored.deviceID === claims.deviceID && stored.sessionID === claims.sessionID
                ? Effect.succeed({ record: stored, creator: false })
                : rejectControl();
            }
            if (counts.pendingSocketAdmissions + counts.activeSocketAdmissions >= ownerVaultMaximumSessions)
              return rejectControl();
            if (counts.preparedSocketOperationIDs.includes(claims.operationID)) return rejectControl();
            return tx.put({ category: "socket.admission", identifier: claims.operationID }, { ...socketAdmission }).pipe(
              Effect.zipRight(tx.put({ category: "root.admission" }, {
                ...counts,
                pendingSocketAdmissions: counts.pendingSocketAdmissions + 1,
                preparedSocketOperationIDs: [...counts.preparedSocketOperationIDs, claims.operationID],
              })),
              Effect.as({ record: socketAdmission, creator: true }),
            );
          }),
        ),
      );
    };

    private acceptSocket = (attachment: SocketAttachment): Effect.Effect<{ readonly record: SocketAdmissionRecord; readonly accepted: boolean }, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "socket.admission", identifier: attachment.operationID }),
          tx.get({ category: "root.admission" }),
        ]).pipe(
          Effect.flatMap(([stored, admission]) => {
            const prior = stored === undefined ? undefined : socketRecord(stored.payload);
            const counts = admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            if (
              prior === undefined || counts === undefined || counts.stopped ||
              prior.bindingNonce !== attachment.bindingNonce || prior.socketGeneration !== attachment.socketGeneration ||
              prior.deviceID !== attachment.deviceID || prior.sessionID !== attachment.sessionID ||
              prior.expiresAtMilliseconds !== attachment.expiresAtMilliseconds
            ) return rejectControl();
            if (prior.phase === "ACCEPTED") return Effect.succeed({ record: prior, accepted: false });
            if (prior.phase !== "PREPARED" || !prior.quotaReserved || counts.pendingSocketAdmissions < 1)
              return rejectControl();
            const next: SocketAdmissionRecord = { ...prior, phase: "ACCEPTED", quotaReserved: false };
            return tx.put({ category: "socket.admission", identifier: attachment.operationID }, { ...next }).pipe(
              Effect.zipRight(tx.put({ category: "root.admission" }, {
                ...counts,
                pendingSocketAdmissions: counts.pendingSocketAdmissions - 1,
                activeSocketAdmissions: counts.activeSocketAdmissions + 1,
                preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                  (operationID) => operationID !== attachment.operationID,
                ),
              })),
              Effect.as({ record: next, accepted: true }),
            );
          }),
        ),
      );
    };

    private releaseSocket = (attachment: SocketAttachment): Effect.Effect<void, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "socket.admission", identifier: attachment.operationID }),
          tx.get({ category: "root.admission" }),
        ]).pipe(
          Effect.flatMap(([stored, admission]) => {
            const prior = stored === undefined ? undefined : socketRecord(stored.payload);
            const counts = admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            if (prior === undefined || counts === undefined || prior.bindingNonce !== attachment.bindingNonce || prior.socketGeneration !== attachment.socketGeneration)
              return Effect.void;
            if (prior.phase === "PREPARED" && prior.quotaReserved) {
              const next: SocketAdmissionRecord = { ...prior, phase: "EXPIRED", quotaReserved: false };
              return tx.put({ category: "socket.admission", identifier: attachment.operationID }, { ...next }).pipe(
                Effect.zipRight(tx.put({ category: "root.admission" }, {
                  ...counts,
                  pendingSocketAdmissions: Math.max(0, counts.pendingSocketAdmissions - 1),
                  preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                    (operationID) => operationID !== attachment.operationID,
                  ),
                })),
              );
            }
            if (prior.phase === "ACCEPTED") {
              const next: SocketAdmissionRecord = { ...prior, phase: "CLOSED" };
              return tx.put({ category: "socket.admission", identifier: attachment.operationID }, { ...next }).pipe(
                Effect.zipRight(tx.put({ category: "root.admission" }, { ...counts, activeSocketAdmissions: Math.max(0, counts.activeSocketAdmissions - 1) })),
              );
            }
            return Effect.void;
          }),
        ),
      );
    };

    /**
     * A PREPARED record survives a process loss but does not imply a live
     * WebSocket. Reconciliation may only expire it; acceptance is reserved
     * for a matching attachment observed by the hibernation runtime.
     */
    private reconcilePreparedSocket = (
      operationID: string,
      nowMilliseconds: number,
    ): Effect.Effect<number | undefined, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        Effect.all([
          tx.get({ category: "socket.admission", identifier: operationID }),
          tx.get({ category: "root.admission" }),
        ]).pipe(
          Effect.flatMap(([stored, admission]) => {
            const prior = stored === undefined ? undefined : socketRecord(stored.payload);
            const counts = admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            if (prior === undefined || counts === undefined) return rejectControl<number | undefined>();
            if (!counts.preparedSocketOperationIDs.includes(operationID)) return Effect.succeed(undefined);
            if (prior.phase !== "PREPARED" || !prior.quotaReserved) {
              return tx.put({ category: "root.admission" }, {
                ...counts,
                preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                  (candidate) => candidate !== operationID,
                ),
              }).pipe(Effect.as(undefined));
            }
            if (prior.expiresAtMilliseconds > nowMilliseconds)
              return Effect.succeed(prior.expiresAtMilliseconds);
            const expired: SocketAdmissionRecord = {
              ...prior,
              phase: "EXPIRED",
              quotaReserved: false,
            };
            return tx.put({ category: "socket.admission", identifier: operationID }, { ...expired }).pipe(
              Effect.zipRight(tx.put({ category: "root.admission" }, {
                ...counts,
                pendingSocketAdmissions: Math.max(0, counts.pendingSocketAdmissions - 1),
                preparedSocketOperationIDs: counts.preparedSocketOperationIDs.filter(
                  (candidate) => candidate !== operationID,
                ),
              })),
              Effect.as(undefined),
            );
          }),
        ),
      );
    };

    private reconcilePreparedSockets = (
      nowMilliseconds: number,
    ): Effect.Effect<number | undefined, SocketStorageFailure> => {
      const repository = makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage);
      return repository.transact((tx) =>
        tx.get({ category: "root.admission" }).pipe(
          Effect.flatMap((admission) => {
            const counts = admission === undefined ? undefined : socketAdmissionCounts(admission.payload);
            return counts === undefined
              ? rejectControl<readonly string[]>()
              : Effect.succeed(counts.preparedSocketOperationIDs);
          }),
        ),
      ).pipe(
        Effect.flatMap((operationIDs) =>
          Effect.forEach(
            operationIDs,
            (operationID) => this.reconcilePreparedSocket(operationID, nowMilliseconds),
            { concurrency: 1 },
          ).pipe(
            Effect.map((expiries) => expiries.reduce<number | undefined>(
              (nearest, expiry) => expiry === undefined
                ? nearest
                : nearest === undefined ? expiry : Math.min(nearest, expiry),
              undefined,
            )),
          ),
        ),
      );
    };

    private socketUpgrade = (request: Request): Effect.Effect<Response> => {
      if (this.socketAdmissions === undefined || this.production === undefined)
        return Effect.succeed(response({ ok: false }, 503));
      const url = new URL(request.url);
      const upgrade = request.headers.get("Upgrade");
      const capability = request.headers.get(ownerVaultSocketAdmissionHeader);
      if (
        request.method !== "GET" || url.pathname !== ownerVaultInternalSocketPath || url.search !== "" ||
        request.body !== null ||
        upgrade === null || upgrade.toLowerCase() !== "websocket" || upgrade.includes(",") ||
        capability === null || capability.includes(",") || new TextEncoder().encode(capability).byteLength > maximumSocketCapabilityBytes ||
        request.headers.has("Enchiridion-Internal-Capability") ||
        [...request.headers.keys()].some(forbiddenSocketCredential) ||
        (request.headers.get("content-length") !== null && request.headers.get("content-length") !== "0")
      ) return Effect.succeed(response({ ok: false }, 400));
      const hint = socketHint(capability);
      if (hint === undefined) return Effect.succeed(response({ ok: false }, 401));
      const fingerprint = socketFingerprint(capability);
      return this.socketAuthority().pipe(
        Effect.flatMap((authority) => {
          const binding: OwnerVaultSocketAdmissionRequestBinding = {
            method: "GET", canonicalQuery: "", bodySHA256: emptyBodySHA256,
            ownerID: hint.ownerID, vaultID: hint.vaultID, deviceID: hint.deviceID, sessionID: hint.sessionID,
            operationID: hint.operationID, upgradeNonce: hint.upgradeNonce,
          };
          return this.socketAdmissions!.verifier.verify({ value: capability }, binding, {
            ownerID: authority.ownerID, vaultID: authority.vaultID, generationEpoch: authority.generationEpoch,
            routingEpoch: authority.routingEpoch, credentialEpoch: authority.credentialEpoch,
            controlEpoch: authority.controlEpoch, securityFloor: authority.securityFloor,
            deviceID: hint.deviceID, sessionID: hint.sessionID, operationID: hint.operationID,
          }, now()).pipe(
            Effect.flatMap((claims) => {
              const root = { ownerID: authority.ownerID, vaultID: authority.vaultID, generationEpoch: authority.generationEpoch, namespaceState: authority.namespaceState } as const;
              const graph = makeOwnerVaultProviderGraph(makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage), root, this.production!);
              if (graph === undefined) return rejectControl<Response>();
              return graph.domains.getDevice(claims.deviceID).pipe(
                Effect.flatMap((device) =>
                  !device.revoked &&
                    device.credentialEpoch === claims.credentialEpoch &&
                    device.securityFloor >= claims.securityFloor
                    ? Effect.all([this.socketNonce(), this.socketNonce()])
                    : rejectControl<readonly [string, string]>(),
                ),
                Effect.flatMap(([bindingNonce, challengeNonce]) =>
                  /^[A-Za-z0-9_-]{22,128}$/u.test(bindingNonce) && /^[A-Za-z0-9_-]{22,128}$/u.test(challengeNonce)
                    ? this.prepareSocket(authority, claims, fingerprint, bindingNonce, challengeNonce, Date.now())
                    : rejectControl(),
                ),
                Effect.flatMap((prepared) => {
                  if (!prepared.creator) return Effect.succeed(response({ ok: false }, 409));
                  return graph.domains.getDevice(prepared.record.deviceID).pipe(
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
                      const attachment: SocketAttachment = {
                        version: 1, operationID: prepared.record.operationID, sessionID: prepared.record.sessionID,
                        deviceID: prepared.record.deviceID, bindingNonce: prepared.record.bindingNonce,
                        socketGeneration: prepared.record.socketGeneration, expiresAtMilliseconds: prepared.record.expiresAtMilliseconds,
                      };
                      return Effect.try({
                        try: () => {
                          const pair = new WebSocketPair();
                          const client = pair[0]; const server = pair[1];
                          server.serializeAttachment(attachment);
                          this.ctx.acceptWebSocket(server);
                          return { client, server };
                        },
                        catch: () => undefined,
                      }).pipe(
                        Effect.flatMap((socket) =>
                          socket === undefined
                            ? this.releaseSocket(attachment).pipe(
                                Effect.catchAll(() => Effect.void),
                                Effect.zipRight(this.deactivateSocketSession(attachment)),
                                Effect.as(response({ ok: false }, 503)),
                              )
                            : this.acceptSocket(attachment).pipe(
                                Effect.tap((accepted) => Effect.sync(() => {
                                  if (accepted.accepted) socket.server.send(JSON.stringify(accepted.record.challenge));
                                })),
                                Effect.tap(() => this.boundary.storage.setAlarm(attachment.expiresAtMilliseconds)),
                                Effect.map(() => new Response(null, { status: 101, webSocket: socket.client })),
                                Effect.catchAll(() => this.releaseSocket(attachment).pipe(
                                  Effect.catchAll(() => Effect.void),
                                  Effect.zipRight(this.deactivateSocketSession(attachment)),
                                  Effect.as(response({ ok: false }, 503)),
                                  Effect.tap(() => Effect.sync(() => socket.server.close(4401, "socket admission failed"))),
                                )),
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

    private revalidateSocket = (attachment: SocketAttachment): Effect.Effect<SocketAdmissionRecord, SocketStorageFailure> =>
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
          const graph = this.production === undefined
            ? undefined
            : makeOwnerVaultProviderGraph(repository, root, this.production);
          if (graph === undefined) return rejectControl<SocketAdmissionRecord>();
          return graph.domains.getDevice(attachment.deviceID).pipe(
            Effect.flatMap((device): Effect.Effect<SocketAdmissionRecord, SocketStorageFailure> => {
              if (
                device.revoked ||
                device.credentialEpoch !== authority.credentialEpoch ||
                device.securityFloor < authority.securityFloor
              ) return rejectControl<SocketAdmissionRecord>();
              return graph.domains.consumeRate({
                sessionID: attachment.sessionID,
                nowMilliseconds: Date.now(),
                maximumFramesPerMinute: socketMaximumFramesPerMinute,
              }).pipe(
                Effect.catchAll(() => rejectControl<void>()),
                Effect.flatMap(() => repository.transact((tx) =>
                  tx.get({ category: "socket.admission", identifier: attachment.operationID }).pipe(
                    Effect.flatMap((stored) => {
                      const admission = stored === undefined ? undefined : socketRecord(stored.payload);
                      return admission === undefined || admission.phase !== "ACCEPTED" ||
                        admission.bindingNonce !== attachment.bindingNonce ||
                        admission.socketGeneration !== attachment.socketGeneration ||
                        admission.sessionID !== attachment.sessionID ||
                        admission.deviceID !== attachment.deviceID ||
                        admission.expiresAtMilliseconds <= Date.now()
                        ? rejectControl<SocketAdmissionRecord>()
                        : Effect.succeed(admission);
                    }),
                  ),
                )),
              );
            }),
            Effect.catchAll(
              (): Effect.Effect<SocketAdmissionRecord, SocketStorageFailure> =>
                rejectControl<SocketAdmissionRecord>(),
            ),
          );
        }),
      );

    private deactivateSocketSession = (attachment: SocketAttachment): Effect.Effect<void> =>
      this.socketAuthority().pipe(
        Effect.flatMap((authority) => {
          const root = {
            ownerID: authority.ownerID,
            vaultID: authority.vaultID,
            generationEpoch: authority.generationEpoch,
            namespaceState: authority.namespaceState,
          } as const;
          const graph = this.production === undefined
            ? undefined
            : makeOwnerVaultProviderGraph(
                makeDurableObjectOwnerVaultStorageRepository(this.boundary.storage),
                root,
                this.production,
              );
          if (graph === undefined) return Effect.void;
          return graph.domains.getDevice(attachment.deviceID).pipe(
            Effect.flatMap((device) => graph.domains.deactivateSession({
              sessionID: attachment.sessionID,
              deviceID: attachment.deviceID,
              authEpoch: device.authEpoch,
              credentialEpoch: device.credentialEpoch,
            })),
          );
        }),
        Effect.catchAll(() => Effect.void),
      );

    private socketMessage = (socket: WebSocket, message: string | ArrayBuffer): Effect.Effect<void> => {
      const attachment = validSocketAttachment(socket.deserializeAttachment()) ? socket.deserializeAttachment() as SocketAttachment : undefined;
      if (attachment === undefined || JSON.stringify(attachment).length > socketAttachmentMaximumBytes)
        return Effect.sync(() => socket.close(4400, "invalid socket attachment"));
      return this.acceptSocket(attachment).pipe(
        Effect.flatMap((accepted) => accepted.accepted
          ? Effect.sync(() => socket.send(JSON.stringify(accepted.record.challenge)))
          : this.revalidateSocket(attachment).pipe(Effect.asVoid),
        ),
        // The frame that races acceptance is deliberately discarded. P06 owns
        // the public sync codec; P05 only admits and durably revalidates it.
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
          if (route?.method === "GET" && route.pathname === ownerVaultInternalSocketPath)
            return this.socketUpgrade(request);
          if (route?.method !== "POST") return Effect.succeed(response({ ok: false }, 404));
          const ovdc =
            route.pathname === ownerVaultPrivateInitializePath ||
            route.pathname === ownerVaultCredentialFencePath ||
            route.pathname === ownerVaultSnapshotPath ||
            route.pathname === ownerVaultRestorePath;
          return readBoundedRequestBody(request, {
            maximumBytes: ovdc ? controlMaximumBodyBytes : maximumBodyBytes,
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
    ): Promise<void> => this.boundary.callbacks.webSocketMessage(this.socketMessage(socket, message));
    override readonly webSocketClose = (socket: WebSocket): void => {
      const candidate = socket.deserializeAttachment();
      const attachment = validSocketAttachment(candidate) ? candidate : undefined;
      if (attachment !== undefined)
        void this.boundary.callbacks.webSocketMessage(
          this.releaseSocket(attachment).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.zipRight(this.deactivateSocketSession(attachment)),
          ),
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
              yield* this.deactivateSocketSession(attachment);
              socket.close(4408, "socket expired");
              continue;
            }
            const accepted = yield* this.acceptSocket(attachment).pipe(
              Effect.catchAll(() => Effect.succeed(undefined)),
            );
            if (accepted?.accepted) socket.send(JSON.stringify(accepted.record.challenge));
            nearest = nearest === undefined
              ? attachment.expiresAtMilliseconds
              : Math.min(nearest, attachment.expiresAtMilliseconds);
          }
          const preparedNearest = yield* this.reconcilePreparedSockets(nowMilliseconds).pipe(
            Effect.catchAll(() => Effect.succeed(undefined)),
          );
          if (preparedNearest !== undefined)
            nearest = nearest === undefined ? preparedNearest : Math.min(nearest, preparedNearest);
          if (nearest === undefined) yield* this.boundary.storage.deleteAlarm();
          else yield* this.boundary.storage.setAlarm(nearest);
        }),
      );
  }
  return OwnerVaultV2;
};
