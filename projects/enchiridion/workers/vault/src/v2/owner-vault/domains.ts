/** @enchiridion/effect-module */
import { Data, Effect } from "effect";
import {
  type OwnerVaultAppendProof,
  ownerVaultAppendProofD0,
  ownerVaultAppendProofNext,
} from "./append-proof";
import type {
  OwnerVaultDomainTransactionError,
  OwnerVaultStorageAddress,
  OwnerVaultStorageRepository,
  OwnerVaultStorageTransactionFailure,
  OwnerVaultTx,
} from "./repository";
import type { OwnerVaultTargetRoot } from "./storage-registry";

/**
 * The one durable domain boundary used by the v2 OwnerVault.  Callers verify
 * signatures and hash payloads before entering this API; this API owns only
 * durable authority, replay fences, sessions, and the append-only log.
 *
 * In particular, transport is deliberately not part of an operation's replay
 * fingerprint. A mobile client may retry a HTTP operation over a WebSocket
 * after reconnecting and must receive the original acknowledgement.
 */

const identifier = /^[A-Za-z0-9_-]{1,128}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const base64url = /^[A-Za-z0-9_-]{16,256}$/u;
const sequenceWidth = 20;

export const ownerVaultMaximumDevices = 256;
export const ownerVaultMaximumOutstandingChallenges = 64;
export const ownerVaultMaximumSessions = 64;
export const ownerVaultMaximumCapabilityReceipts = 4_096;
export const ownerVaultMaximumOperationReceiptTTLSeconds = 3_600;
export const ownerVaultMaximumSecurityReceiptTTLSeconds = 300;

export class OwnerVaultDomainError extends Data.TaggedError("OwnerVaultDomainError")<{
  readonly reason:
    | "already_exists"
    | "authorization_denied"
    | "capability_replayed"
    | "challenge_consumed"
    | "challenge_expired"
    | "challenge_not_found"
    | "identity_conflict"
    | "invalid_input"
    | "nonce_replayed"
    | "observed_high_water_ahead"
    | "quota_exceeded"
    | "rate_limited"
    | "replay_conflict"
    | "session_expired"
    | "session_not_found"
    | "state_corrupt"
    | "temporarily_unavailable";
}> {}

export interface OwnerVaultDevice {
  readonly deviceID: string;
  readonly publicKeySPKI: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly revoked: boolean;
  readonly securityFloor: number;
}

export interface OwnerVaultChallenge {
  readonly challengeID: string;
  readonly challengeBase64: string;
  readonly challengeAudience: string;
  readonly devicePublicKey: string;
  readonly expiresAtMilliseconds: number;
  readonly consumed: boolean;
}

export interface OwnerVaultSessionRecord {
  readonly sessionID: string;
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly securityFloor: number;
  readonly assertionExpiresAtMilliseconds: number;
  readonly resumeTokenHash: string;
}

export interface OwnerVaultAppendAcknowledgement {
  readonly operationID: string;
  readonly payloadHash: string;
  readonly logSequence: number;
  readonly replayed: boolean;
}

export interface OwnerVaultAppendInput {
  readonly operationID: string;
  /** Canonical operation fingerprint, independent of HTTP versus WebSocket. */
  readonly fingerprint: string;
  readonly payloadHash: string;
  /** Opaque canonical payload encoded by the authenticated transport layer. */
  readonly payloadBase64: string;
  /** Diagnostic only; the first committed transport is retained in the log. */
  readonly source: "http" | "websocket";
  readonly observedHighWater: number;
  readonly nowSeconds: number;
  readonly receiptExpiresAtSeconds: number;
  readonly actor: {
    readonly deviceID: string;
    readonly authEpoch: number;
    readonly credentialEpoch: number;
    readonly securityFloor: number;
  };
  readonly nonce: {
    readonly value: string;
    readonly expiresAtSeconds: number;
    readonly fingerprint: string;
  };
  readonly capability: { readonly jti: string; readonly expiresAtSeconds: number };
}

export interface OwnerVaultDomainProvider {
  readonly initialize: () => Effect.Effect<void, OwnerVaultDomainError>;
  readonly issueChallenge: (
    challenge: OwnerVaultChallenge,
    nowMilliseconds: number,
  ) => Effect.Effect<OwnerVaultChallenge, OwnerVaultDomainError>;
  readonly readChallenge: (
    challengeID: string,
    nowMilliseconds: number,
  ) => Effect.Effect<OwnerVaultChallenge, OwnerVaultDomainError>;
  readonly registerDevice: (input: {
    readonly registrationID: string;
    readonly proofFingerprint: string;
    readonly challengeID: string;
    readonly device: OwnerVaultDevice;
    readonly nowMilliseconds: number;
  }) => Effect.Effect<
    { readonly device: OwnerVaultDevice; readonly replayed: boolean },
    OwnerVaultDomainError
  >;
  readonly getDevice: (deviceID: string) => Effect.Effect<OwnerVaultDevice, OwnerVaultDomainError>;
  readonly revokeDevice: (input: {
    readonly requestID: string;
    readonly fingerprint: string;
    readonly actor: Pick<
      OwnerVaultDevice,
      "deviceID" | "authEpoch" | "credentialEpoch" | "securityFloor"
    >;
    readonly targetDeviceID: string;
    readonly nowSeconds: number;
    readonly receiptExpiresAtSeconds: number;
  }) => Effect.Effect<OwnerVaultDevice, OwnerVaultDomainError>;
  readonly append: (
    input: OwnerVaultAppendInput,
  ) => Effect.Effect<OwnerVaultAppendAcknowledgement, OwnerVaultDomainError>;
  readonly establishSession: (
    input: OwnerVaultSessionRecord,
  ) => Effect.Effect<OwnerVaultSessionRecord, OwnerVaultDomainError>;
  readonly consumeRate: (input: {
    readonly sessionID: string;
    readonly nowMilliseconds: number;
    readonly maximumFramesPerMinute: number;
  }) => Effect.Effect<OwnerVaultSessionRecord, OwnerVaultDomainError>;
  /** Close owns the cleanup of its session, resume index, and rate window. */
  readonly deactivateSession: (input: {
    readonly sessionID: string;
    readonly deviceID: string;
    readonly authEpoch: number;
    readonly credentialEpoch: number;
  }) => Effect.Effect<void, OwnerVaultDomainError>;
  /** Alarm-driven expiry has the same cleanup path but no actor ownership check. */
  readonly expireSession: (
    sessionID: string,
    nowMilliseconds: number,
  ) => Effect.Effect<boolean, OwnerVaultDomainError>;
  /** Alarm-driven reclamation keeps the capability-receipt cardinality cap live. */
  readonly expireCapability: (
    jti: string,
    nowSeconds: number,
  ) => Effect.Effect<boolean, OwnerVaultDomainError>;
}

interface Admission {
  readonly activeChallenges: number;
  readonly activeDevices: number;
  readonly activeSessions: number;
  readonly capabilityReceipts: number;
  /** A credential fence is durable and makes every admission path fail closed. */
  readonly stopped: boolean;
  /** Reserved/active socket counts make accept-outside-transaction bounded. */
  readonly pendingSocketAdmissions: number;
  readonly activeSocketAdmissions: number;
  /** Only PREPARED operation IDs are indexed, so alarms can release leases
   * that survived an isolate loss before a live attachment was accepted. */
  readonly preparedSocketOperationIDs: readonly string[];
  /** Socket capability JTIs are retained exactly until their signed expiry.
   * The socket DO bounds this list to its admission capacity and reaps it
   * through its own alarm, including after an isolate restart. */
  readonly socketReplayJTIs: readonly string[];
}
interface Floors {
  readonly securityFloor: number;
}
interface LogHead extends OwnerVaultAppendProof {}
interface OperationReceipt {
  readonly kind: "append" | "device-registration" | "device-revoke";
  readonly fingerprint: string;
  readonly expiresAtSeconds: number;
  readonly result: Readonly<Record<string, unknown>>;
}
interface NonceClaim {
  readonly expiresAtSeconds: number;
  readonly fingerprint: string;
}
interface CapabilityReceipt {
  readonly operationID: string;
  readonly expiresAtSeconds: number;
  readonly fingerprint: string;
  readonly result: { readonly logSequence: number; readonly payloadHash: string };
}
interface JtiClaim {
  readonly operationID: string;
  readonly expiresAtSeconds: number;
}
interface RateWindow {
  readonly startedAtMilliseconds: number;
  readonly count: number;
}
export interface OwnerVaultAppendLogEntry {
  readonly operationID: string;
  readonly fingerprint: string;
  readonly payloadHash: string;
  readonly payloadBase64: string;
  readonly source: "http" | "websocket";
  readonly deviceID: string;
  readonly logSequence: number;
}
interface OperationIndex {
  readonly fingerprint: string;
  readonly logSequence: number;
  readonly payloadHash: string;
}

const address = (
  category: OwnerVaultStorageAddress["category"],
  identifierValue?: string,
): OwnerVaultStorageAddress =>
  identifierValue === undefined ? { category } : { category, identifier: identifierValue };
const fail = <A = never>(
  reason: OwnerVaultDomainError["reason"],
): Effect.Effect<A, OwnerVaultDomainError> => Effect.fail(new OwnerVaultDomainError({ reason }));
const isSafeNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isSafePositive = (value: unknown): value is number => isSafeNonNegative(value) && value > 0;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sameRoot = (left: OwnerVaultTargetRoot, right: OwnerVaultTargetRoot): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch &&
  left.namespaceState === right.namespaceState;
const sequenceID = (value: number): string => value.toString().padStart(sequenceWidth, "0");
const validReceiptTTL = (
  nowSeconds: number,
  expiresAtSeconds: number,
  maximum = ownerVaultMaximumOperationReceiptTTLSeconds,
): boolean =>
  isSafeNonNegative(nowSeconds) &&
  isSafePositive(expiresAtSeconds) &&
  expiresAtSeconds > nowSeconds &&
  expiresAtSeconds - nowSeconds <= maximum;

const decodeDevice = (value: unknown): OwnerVaultDevice | undefined => {
  if (
    !isRecord(value) ||
    !exact(value, [
      "authEpoch",
      "credentialEpoch",
      "deviceID",
      "publicKeySPKI",
      "revoked",
      "securityFloor",
    ])
  )
    return undefined;
  return typeof value.deviceID === "string" &&
    identifier.test(value.deviceID) &&
    typeof value.publicKeySPKI === "string" &&
    value.publicKeySPKI.length > 0 &&
    value.publicKeySPKI.length <= 8_192 &&
    isSafePositive(value.authEpoch) &&
    isSafePositive(value.credentialEpoch) &&
    typeof value.revoked === "boolean" &&
    isSafeNonNegative(value.securityFloor)
    ? {
        deviceID: value.deviceID,
        publicKeySPKI: value.publicKeySPKI,
        authEpoch: value.authEpoch,
        credentialEpoch: value.credentialEpoch,
        revoked: value.revoked,
        securityFloor: value.securityFloor,
      }
    : undefined;
};
const decodeChallenge = (value: unknown): OwnerVaultChallenge | undefined => {
  if (
    !isRecord(value) ||
    !exact(value, [
      "challengeAudience",
      "challengeBase64",
      "challengeID",
      "consumed",
      "devicePublicKey",
      "expiresAtMilliseconds",
    ])
  )
    return undefined;
  return typeof value.challengeID === "string" &&
    identifier.test(value.challengeID) &&
    typeof value.challengeBase64 === "string" &&
    value.challengeBase64.length > 0 &&
    value.challengeBase64.length <= 256 &&
    typeof value.challengeAudience === "string" &&
    value.challengeAudience.length > 0 &&
    value.challengeAudience.length <= 512 &&
    typeof value.devicePublicKey === "string" &&
    value.devicePublicKey.length > 0 &&
    value.devicePublicKey.length <= 8_192 &&
    isSafePositive(value.expiresAtMilliseconds) &&
    typeof value.consumed === "boolean"
    ? {
        challengeID: value.challengeID,
        challengeBase64: value.challengeBase64,
        challengeAudience: value.challengeAudience,
        devicePublicKey: value.devicePublicKey,
        expiresAtMilliseconds: value.expiresAtMilliseconds,
        consumed: value.consumed,
      }
    : undefined;
};
const decodeAdmission = (value: unknown): Admission | undefined =>
  isRecord(value) &&
  (exact(value, ["activeChallenges", "activeDevices", "activeSessions", "capabilityReceipts"]) ||
    exact(value, [
      "activeChallenges",
      "activeDevices",
      "activeSessions",
      "capabilityReceipts",
      "stopped",
    ]) ||
    exact(value, [
      "activeChallenges",
      "activeDevices",
      "activeSessions",
      "capabilityReceipts",
      "stopped",
      "pendingSocketAdmissions",
      "activeSocketAdmissions",
    ]) ||
    exact(value, [
      "activeChallenges",
      "activeDevices",
      "activeSessions",
      "capabilityReceipts",
      "stopped",
      "pendingSocketAdmissions",
      "activeSocketAdmissions",
      "preparedSocketOperationIDs",
    ]) ||
    exact(value, [
      "activeChallenges",
      "activeDevices",
      "activeSessions",
      "capabilityReceipts",
      "stopped",
      "pendingSocketAdmissions",
      "activeSocketAdmissions",
      "preparedSocketOperationIDs",
      "socketReplayJTIs",
    ])) &&
  isSafeNonNegative(value.activeChallenges) &&
  isSafeNonNegative(value.activeDevices) &&
  isSafeNonNegative(value.activeSessions) &&
  isSafeNonNegative(value.capabilityReceipts) &&
  (value.stopped === undefined || typeof value.stopped === "boolean") &&
  (value.pendingSocketAdmissions === undefined ||
    isSafeNonNegative(value.pendingSocketAdmissions)) &&
  (value.activeSocketAdmissions === undefined || isSafeNonNegative(value.activeSocketAdmissions)) &&
  (value.preparedSocketOperationIDs === undefined ||
    (Array.isArray(value.preparedSocketOperationIDs) &&
      value.preparedSocketOperationIDs.length <= ownerVaultMaximumSessions &&
      value.preparedSocketOperationIDs.every(
        (entry) => typeof entry === "string" && identifier.test(entry),
      ) &&
      new Set(value.preparedSocketOperationIDs).size ===
        value.preparedSocketOperationIDs.length)) &&
  (value.socketReplayJTIs === undefined ||
    (Array.isArray(value.socketReplayJTIs) &&
      value.socketReplayJTIs.length <= ownerVaultMaximumSessions &&
      value.socketReplayJTIs.every(
        (entry) => typeof entry === "string" && identifier.test(entry) && entry.length <= 64,
      ) &&
      new Set(value.socketReplayJTIs).size === value.socketReplayJTIs.length))
    ? {
        activeChallenges: value.activeChallenges,
        activeDevices: value.activeDevices,
        activeSessions: value.activeSessions,
        capabilityReceipts: value.capabilityReceipts,
        stopped: value.stopped === true,
        pendingSocketAdmissions: value.pendingSocketAdmissions ?? 0,
        activeSocketAdmissions: value.activeSocketAdmissions ?? 0,
        preparedSocketOperationIDs: value.preparedSocketOperationIDs ?? [],
        socketReplayJTIs: value.socketReplayJTIs ?? [],
      }
    : undefined;
const decodeFloors = (value: unknown): Floors | undefined =>
  isRecord(value) && exact(value, ["securityFloor"]) && isSafeNonNegative(value.securityFloor)
    ? { securityFloor: value.securityFloor }
    : undefined;
const decodeLogHead = (value: unknown): LogHead | undefined =>
  isRecord(value) &&
  exact(value, ["appendLogDigest", "appendLogSequence"]) &&
  isSafeNonNegative(value.appendLogSequence) &&
  typeof value.appendLogDigest === "string" &&
  sha256.test(value.appendLogDigest)
    ? { appendLogSequence: value.appendLogSequence, appendLogDigest: value.appendLogDigest }
    : undefined;
const decodeReceipt = (value: unknown): OperationReceipt | undefined => {
  if (!isRecord(value) || !exact(value, ["expiresAtSeconds", "fingerprint", "kind", "result"]))
    return undefined;
  return (value.kind === "append" ||
    value.kind === "device-registration" ||
    value.kind === "device-revoke") &&
    typeof value.fingerprint === "string" &&
    sha256.test(value.fingerprint) &&
    isSafePositive(value.expiresAtSeconds) &&
    isRecord(value.result)
    ? {
        kind: value.kind,
        fingerprint: value.fingerprint,
        expiresAtSeconds: value.expiresAtSeconds,
        result: value.result,
      }
    : undefined;
};
const decodeNonce = (value: unknown): NonceClaim | undefined =>
  isRecord(value) &&
  exact(value, ["expiresAtSeconds", "fingerprint"]) &&
  isSafePositive(value.expiresAtSeconds) &&
  typeof value.fingerprint === "string" &&
  sha256.test(value.fingerprint)
    ? { expiresAtSeconds: value.expiresAtSeconds, fingerprint: value.fingerprint }
    : undefined;
const decodeCapability = (value: unknown): CapabilityReceipt | undefined =>
  isRecord(value) &&
  exact(value, ["expiresAtSeconds", "fingerprint", "operationID", "result"]) &&
  isSafePositive(value.expiresAtSeconds) &&
  typeof value.operationID === "string" &&
  identifier.test(value.operationID) &&
  typeof value.fingerprint === "string" &&
  sha256.test(value.fingerprint) &&
  isRecord(value.result) &&
  exact(value.result, ["logSequence", "payloadHash"]) &&
  isSafePositive(value.result.logSequence) &&
  typeof value.result.payloadHash === "string" &&
  sha256.test(value.result.payloadHash)
    ? {
        expiresAtSeconds: value.expiresAtSeconds,
        operationID: value.operationID,
        fingerprint: value.fingerprint,
        result: { logSequence: value.result.logSequence, payloadHash: value.result.payloadHash },
      }
    : undefined;
const decodeJtiClaim = (value: unknown): JtiClaim | undefined =>
  isRecord(value) &&
  exact(value, ["expiresAtSeconds", "operationID"]) &&
  isSafePositive(value.expiresAtSeconds) &&
  typeof value.operationID === "string" &&
  identifier.test(value.operationID)
    ? { expiresAtSeconds: value.expiresAtSeconds, operationID: value.operationID }
    : undefined;
const decodeSession = (value: unknown): OwnerVaultSessionRecord | undefined => {
  if (
    !isRecord(value) ||
    !exact(value, [
      "assertionExpiresAtMilliseconds",
      "authEpoch",
      "credentialEpoch",
      "deviceID",
      "resumeTokenHash",
      "securityFloor",
      "sessionID",
    ])
  )
    return undefined;
  return typeof value.sessionID === "string" &&
    identifier.test(value.sessionID) &&
    typeof value.deviceID === "string" &&
    identifier.test(value.deviceID) &&
    isSafePositive(value.authEpoch) &&
    isSafePositive(value.credentialEpoch) &&
    isSafeNonNegative(value.securityFloor) &&
    isSafePositive(value.assertionExpiresAtMilliseconds) &&
    typeof value.resumeTokenHash === "string" &&
    sha256.test(value.resumeTokenHash)
    ? {
        sessionID: value.sessionID,
        deviceID: value.deviceID,
        authEpoch: value.authEpoch,
        credentialEpoch: value.credentialEpoch,
        securityFloor: value.securityFloor,
        assertionExpiresAtMilliseconds: value.assertionExpiresAtMilliseconds,
        resumeTokenHash: value.resumeTokenHash,
      }
    : undefined;
};
const decodeRate = (value: unknown): RateWindow | undefined =>
  isRecord(value) &&
  exact(value, ["count", "startedAtMilliseconds"]) &&
  isSafeNonNegative(value.count) &&
  isSafeNonNegative(value.startedAtMilliseconds)
    ? { count: value.count, startedAtMilliseconds: value.startedAtMilliseconds }
    : undefined;
export const decodeOwnerVaultAppendLogEntry = (
  value: unknown,
): OwnerVaultAppendLogEntry | undefined => {
  if (
    !isRecord(value) ||
    !exact(value, [
      "deviceID",
      "fingerprint",
      "logSequence",
      "operationID",
      "payloadBase64",
      "payloadHash",
      "source",
    ])
  )
    return undefined;
  return typeof value.operationID === "string" &&
    identifier.test(value.operationID) &&
    typeof value.fingerprint === "string" &&
    sha256.test(value.fingerprint) &&
    typeof value.payloadHash === "string" &&
    sha256.test(value.payloadHash) &&
    typeof value.payloadBase64 === "string" &&
    value.payloadBase64.length <= 1_048_576 &&
    (value.source === "http" || value.source === "websocket") &&
    typeof value.deviceID === "string" &&
    identifier.test(value.deviceID) &&
    isSafePositive(value.logSequence)
    ? {
        operationID: value.operationID,
        fingerprint: value.fingerprint,
        payloadHash: value.payloadHash,
        payloadBase64: value.payloadBase64,
        source: value.source,
        deviceID: value.deviceID,
        logSequence: value.logSequence,
      }
    : undefined;
};
const decodeAppendEntry = decodeOwnerVaultAppendLogEntry;
const decodeOperationIndex = (value: unknown): OperationIndex | undefined =>
  isRecord(value) &&
  exact(value, ["fingerprint", "logSequence", "payloadHash"]) &&
  typeof value.fingerprint === "string" &&
  sha256.test(value.fingerprint) &&
  isSafePositive(value.logSequence) &&
  typeof value.payloadHash === "string" &&
  sha256.test(value.payloadHash)
    ? {
        fingerprint: value.fingerprint,
        logSequence: value.logSequence,
        payloadHash: value.payloadHash,
      }
    : undefined;

const storageFailure = (error: unknown): OwnerVaultDomainError => {
  if (isRecord(error) && error._tag === "OwnerVaultDomainTransactionError") {
    const reason = error.reason;
    if (
      reason === "authorization_denied" ||
      reason === "capability_replayed" ||
      reason === "nonce_replayed" ||
      reason === "observed_high_water_ahead" ||
      reason === "rate_limited" ||
      reason === "replay_conflict"
    )
      return new OwnerVaultDomainError({ reason });
    if (reason === "operation_capacity")
      return new OwnerVaultDomainError({ reason: "quota_exceeded" });
  }
  if (isRecord(error) && error.reason === "quota_exceeded")
    return new OwnerVaultDomainError({ reason: "quota_exceeded" });
  if (
    isRecord(error) &&
    (error.reason === "state_corrupt" || error.reason === "migration_required")
  )
    return new OwnerVaultDomainError({ reason: "state_corrupt" });
  return new OwnerVaultDomainError({ reason: "temporarily_unavailable" });
};

const transactionFailure = (error: OwnerVaultDomainError): OwnerVaultStorageTransactionFailure => {
  const domain = (
    reason: OwnerVaultDomainTransactionError["reason"],
  ): OwnerVaultDomainTransactionError => ({
    _tag: "OwnerVaultDomainTransactionError",
    reason,
  });
  switch (error.reason) {
    case "authorization_denied":
    case "capability_replayed":
    case "nonce_replayed":
    case "observed_high_water_ahead":
    case "rate_limited":
    case "replay_conflict":
      return domain(error.reason);
    case "quota_exceeded":
      return domain("operation_capacity");
    case "state_corrupt":
      return { _tag: "OwnerVaultStorageError", reason: "state_corrupt" };
    case "temporarily_unavailable":
      return { _tag: "OwnerVaultStorageError", reason: "invalid_record" };
    case "already_exists":
      return domain("replay_conflict");
    case "challenge_consumed":
    case "challenge_expired":
    case "challenge_not_found":
    case "identity_conflict":
    case "session_expired":
    case "session_not_found":
      return domain("authorization_denied");
    case "invalid_input":
      return { _tag: "OwnerVaultStorageError", reason: "invalid_record" };
  }
};

export const makeOwnerVaultDomainProvider = (
  storage: OwnerVaultStorageRepository,
  root: OwnerVaultTargetRoot,
): OwnerVaultDomainProvider => {
  const transact = <A>(
    operation: (tx: OwnerVaultTx) => Effect.Effect<A, OwnerVaultDomainError>,
  ): Effect.Effect<A, OwnerVaultDomainError> =>
    storage
      .transact((tx) => operation(tx).pipe(Effect.mapError(transactionFailure)))
      .pipe(Effect.mapError(storageFailure));
  const read = <A>(
    tx: OwnerVaultTx,
    target: OwnerVaultStorageAddress,
    decode: (value: unknown) => A | undefined,
  ): Effect.Effect<A | undefined, OwnerVaultDomainError> =>
    tx.get(target).pipe(
      Effect.mapError(storageFailure),
      Effect.flatMap((stored) =>
        stored === undefined
          ? Effect.succeed(undefined)
          : (() => {
              const decoded = decode(stored.payload);
              return decoded === undefined ? fail<A>("state_corrupt") : Effect.succeed(decoded);
            })(),
      ),
    );
  const write = (
    tx: OwnerVaultTx,
    target: OwnerVaultStorageAddress,
    payload: Readonly<Record<string, unknown>>,
  ) => tx.put(target, payload).pipe(Effect.mapError(storageFailure));
  const remove = (tx: OwnerVaultTx, target: OwnerVaultStorageAddress) =>
    tx.delete(target).pipe(Effect.mapError(storageFailure));
  const requireRoot = (tx: OwnerVaultTx): Effect.Effect<void, OwnerVaultDomainError> =>
    read(tx, address("root.identity"), (value): OwnerVaultTargetRoot | undefined => {
      if (
        !isRecord(value) ||
        !exact(value, ["generationEpoch", "namespaceState", "ownerID", "vaultID"])
      )
        return undefined;
      return typeof value.ownerID === "string" &&
        typeof value.vaultID === "string" &&
        isSafePositive(value.generationEpoch) &&
        (value.namespaceState === "PRIVATE" || value.namespaceState === "ACTIVE")
        ? {
            ownerID: value.ownerID,
            vaultID: value.vaultID,
            generationEpoch: value.generationEpoch,
            namespaceState: value.namespaceState,
          }
        : undefined;
    }).pipe(
      Effect.flatMap((stored) =>
        stored === undefined
          ? fail("identity_conflict")
          : sameRoot(stored, root)
            ? getAdmission(tx).pipe(
                Effect.flatMap((admission) =>
                  admission.stopped ? fail("authorization_denied") : Effect.void,
                ),
              )
            : fail("identity_conflict"),
      ),
    );
  const getAdmission = (tx: OwnerVaultTx) =>
    read(tx, address("root.admission"), decodeAdmission).pipe(
      Effect.flatMap((value) =>
        value === undefined ? fail<Admission>("state_corrupt") : Effect.succeed(value),
      ),
    );
  const getFloors = (tx: OwnerVaultTx) =>
    read(tx, address("root.floors"), decodeFloors).pipe(
      Effect.flatMap((value) =>
        value === undefined ? fail<Floors>("state_corrupt") : Effect.succeed(value),
      ),
    );
  const getHead = (tx: OwnerVaultTx) =>
    Effect.all([
      read(tx, address("root.log-head"), decodeLogHead),
      read(tx, address("append-log.head"), decodeLogHead),
    ]).pipe(
      Effect.flatMap(([rootHead, appendHead]) =>
        rootHead === undefined ||
        appendHead === undefined ||
        rootHead.appendLogSequence !== appendHead.appendLogSequence ||
        rootHead.appendLogDigest !== appendHead.appendLogDigest
          ? fail<LogHead>("state_corrupt")
          : Effect.succeed(rootHead),
      ),
    );
  const authenticatedDevice = (
    tx: OwnerVaultTx,
    actor:
      | OwnerVaultAppendInput["actor"]
      | {
          readonly deviceID: string;
          readonly authEpoch: number;
          readonly credentialEpoch: number;
          readonly securityFloor: number;
        },
  ) =>
    Effect.all([read(tx, address("device", actor.deviceID), decodeDevice), getFloors(tx)]).pipe(
      Effect.flatMap(([device, floors]) =>
        device === undefined ||
        device.revoked ||
        device.authEpoch !== actor.authEpoch ||
        device.credentialEpoch !== actor.credentialEpoch ||
        device.securityFloor !== actor.securityFloor ||
        actor.authEpoch < floors.securityFloor
          ? fail<OwnerVaultDevice>("authorization_denied")
          : Effect.succeed(device),
      ),
    );

  const initialize = (): Effect.Effect<void, OwnerVaultDomainError> =>
    transact((tx) =>
      tx.initialize(root).pipe(
        Effect.mapError(storageFailure),
        Effect.zipRight(read(tx, address("root.admission"), decodeAdmission)),
        Effect.flatMap((admission) =>
          admission === undefined
            ? write(tx, address("root.admission"), {
                activeChallenges: 0,
                activeDevices: 0,
                activeSessions: 0,
                capabilityReceipts: 0,
                stopped: false,
                pendingSocketAdmissions: 0,
                activeSocketAdmissions: 0,
                preparedSocketOperationIDs: [],
                socketReplayJTIs: [],
              })
            : Effect.void,
        ),
        Effect.zipRight(read(tx, address("root.floors"), decodeFloors)),
        Effect.flatMap((floors) =>
          floors === undefined
            ? write(tx, address("root.floors"), { securityFloor: 0 })
            : Effect.void,
        ),
        Effect.zipRight(read(tx, address("root.log-head"), decodeLogHead)),
        Effect.flatMap((head) =>
          head === undefined
            ? write(tx, address("root.log-head"), {
                appendLogSequence: 0,
                appendLogDigest: ownerVaultAppendProofD0(root),
              })
            : Effect.void,
        ),
        Effect.zipRight(read(tx, address("append-log.head"), decodeLogHead)),
        Effect.flatMap((head) =>
          head === undefined
            ? write(tx, address("append-log.head"), {
                appendLogSequence: 0,
                appendLogDigest: ownerVaultAppendProofD0(root),
              })
            : Effect.void,
        ),
        // P03's staged-object state is target-local derived state, but it must
        // exist before any blob provider is allowed to reserve capacity. Keep
        // its first write in this very same initialization transaction so a
        // restart can never observe an initialized root with an uninitialised
        // blob quota ledger.
        Effect.zipRight(
          read(tx, address("blob.accounting"), (value) => (isRecord(value) ? value : undefined)),
        ),
        Effect.flatMap((accounting) =>
          accounting === undefined
            ? write(tx, address("blob.accounting"), {
                referencedBytes: 0,
                reservedStageBytes: 0,
                prospectiveFinalBytes: 0,
                leaseIDs: [],
                purgeSHA256s: [],
              })
            : Effect.void,
        ),
        Effect.zipRight(getHead(tx).pipe(Effect.asVoid)),
      ),
    );

  const issueChallenge = (
    challenge: OwnerVaultChallenge,
    nowMilliseconds: number,
  ): Effect.Effect<OwnerVaultChallenge, OwnerVaultDomainError> => {
    if (
      decodeChallenge(challenge) === undefined ||
      !isSafeNonNegative(nowMilliseconds) ||
      challenge.expiresAtMilliseconds <= nowMilliseconds
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(getAdmission(tx)),
        Effect.flatMap((admission) =>
          read(tx, address("device-challenge", challenge.challengeID), decodeChallenge).pipe(
            Effect.flatMap((existing) => {
              if (existing !== undefined) return fail<OwnerVaultChallenge>("already_exists");
              if (admission.activeChallenges >= ownerVaultMaximumOutstandingChallenges)
                return fail<OwnerVaultChallenge>("quota_exceeded");
              return write(tx, address("device-challenge", challenge.challengeID), {
                ...challenge,
              }).pipe(
                Effect.zipRight(
                  write(tx, address("root.admission"), {
                    ...admission,
                    activeChallenges: admission.activeChallenges + 1,
                  }),
                ),
                Effect.as(challenge),
              );
            }),
          ),
        ),
      ),
    );
  };
  const readChallenge = (
    challengeID: string,
    nowMilliseconds: number,
  ): Effect.Effect<OwnerVaultChallenge, OwnerVaultDomainError> =>
    !identifier.test(challengeID) || !isSafeNonNegative(nowMilliseconds)
      ? fail("invalid_input")
      : transact((tx) =>
          requireRoot(tx).pipe(
            Effect.zipRight(read(tx, address("device-challenge", challengeID), decodeChallenge)),
            Effect.flatMap((challenge) =>
              challenge === undefined
                ? fail("challenge_not_found")
                : challenge.expiresAtMilliseconds <= nowMilliseconds
                  ? fail("challenge_expired")
                  : Effect.succeed(challenge),
            ),
          ),
        );
  const registerDevice: OwnerVaultDomainProvider["registerDevice"] = (input) => {
    if (
      !identifier.test(input.registrationID) ||
      !sha256.test(input.proofFingerprint) ||
      !identifier.test(input.challengeID) ||
      decodeDevice(input.device) === undefined ||
      !isSafeNonNegative(input.nowMilliseconds)
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(
          read(tx, address("operation-receipt", input.registrationID), decodeReceipt),
        ),
        Effect.flatMap((receipt) => {
          if (receipt !== undefined) {
            if (
              receipt.kind !== "device-registration" ||
              receipt.fingerprint !== input.proofFingerprint
            )
              return fail("replay_conflict");
            const device = decodeDevice(receipt.result.device);
            return device === undefined
              ? fail("state_corrupt")
              : Effect.succeed({ device, replayed: true });
          }
          return Effect.all([
            getAdmission(tx),
            read(tx, address("device-challenge", input.challengeID), decodeChallenge),
            read(tx, address("device", input.device.deviceID), decodeDevice),
          ]).pipe(
            Effect.flatMap(([admission, challenge, existingDevice]) => {
              if (challenge === undefined) return fail("challenge_not_found");
              if (challenge.expiresAtMilliseconds <= input.nowMilliseconds)
                return fail("challenge_expired");
              if (challenge.consumed) return fail("challenge_consumed");
              if (
                challenge.devicePublicKey !== input.device.publicKeySPKI ||
                existingDevice !== undefined
              )
                return fail("authorization_denied");
              if (admission.activeDevices >= ownerVaultMaximumDevices)
                return fail("quota_exceeded");
              const consumed: OwnerVaultChallenge = { ...challenge, consumed: true };
              const result = { device: input.device };
              return write(tx, address("device-challenge", input.challengeID), {
                ...consumed,
              }).pipe(
                Effect.zipRight(
                  write(tx, address("device", input.device.deviceID), { ...input.device }),
                ),
                Effect.zipRight(
                  write(tx, address("operation-receipt", input.registrationID), {
                    kind: "device-registration",
                    fingerprint: input.proofFingerprint,
                    expiresAtSeconds:
                      Math.floor(input.nowMilliseconds / 1_000) +
                      ownerVaultMaximumOperationReceiptTTLSeconds,
                    result,
                  }),
                ),
                Effect.zipRight(
                  write(tx, address("root.admission"), {
                    ...admission,
                    activeDevices: admission.activeDevices + 1,
                    activeChallenges: Math.max(0, admission.activeChallenges - 1),
                  }),
                ),
                Effect.as({ device: input.device, replayed: false }),
              );
            }),
          );
        }),
      ),
    );
  };
  const getDevice = (deviceID: string): Effect.Effect<OwnerVaultDevice, OwnerVaultDomainError> =>
    !identifier.test(deviceID)
      ? fail("invalid_input")
      : transact((tx) =>
          requireRoot(tx).pipe(
            Effect.zipRight(read(tx, address("device", deviceID), decodeDevice)),
            Effect.flatMap((device) =>
              device === undefined ? fail("authorization_denied") : Effect.succeed(device),
            ),
          ),
        );
  const revokeDevice: OwnerVaultDomainProvider["revokeDevice"] = (input) => {
    if (
      !identifier.test(input.requestID) ||
      !sha256.test(input.fingerprint) ||
      !identifier.test(input.targetDeviceID) ||
      !isSafeNonNegative(input.nowSeconds) ||
      !validReceiptTTL(input.nowSeconds, input.receiptExpiresAtSeconds)
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(read(tx, address("operation-receipt", input.requestID), decodeReceipt)),
        Effect.flatMap((receipt) => {
          if (receipt !== undefined) {
            if (receipt.kind !== "device-revoke" || receipt.fingerprint !== input.fingerprint)
              return fail("replay_conflict");
            const device = decodeDevice(receipt.result.device);
            return device === undefined ? fail("state_corrupt") : Effect.succeed(device);
          }
          return authenticatedDevice(tx, input.actor).pipe(
            Effect.zipRight(
              Effect.all([
                getFloors(tx),
                read(tx, address("device", input.targetDeviceID), decodeDevice),
              ]),
            ),
            Effect.flatMap(([floors, target]) => {
              if (target === undefined) return fail("authorization_denied");
              const nextFloor = floors.securityFloor + 1;
              const revoked = target.revoked
                ? target
                : {
                    ...target,
                    revoked: true,
                    authEpoch: target.authEpoch + 1,
                    securityFloor: nextFloor,
                  };
              return write(tx, address("device", target.deviceID), { ...revoked }).pipe(
                Effect.zipRight(write(tx, address("root.floors"), { securityFloor: nextFloor })),
                Effect.zipRight(
                  write(tx, address("operation-receipt", input.requestID), {
                    kind: "device-revoke",
                    fingerprint: input.fingerprint,
                    expiresAtSeconds: input.receiptExpiresAtSeconds,
                    result: { device: revoked },
                  }),
                ),
                Effect.as(revoked),
              );
            }),
          );
        }),
      ),
    );
  };
  const append: OwnerVaultDomainProvider["append"] = (input) => {
    if (
      !identifier.test(input.operationID) ||
      !sha256.test(input.fingerprint) ||
      !sha256.test(input.payloadHash) ||
      typeof input.payloadBase64 !== "string" ||
      input.payloadBase64.length > 1_048_576 ||
      !isSafeNonNegative(input.observedHighWater) ||
      !validReceiptTTL(input.nowSeconds, input.receiptExpiresAtSeconds) ||
      !identifier.test(input.actor.deviceID) ||
      !isSafePositive(input.actor.authEpoch) ||
      !isSafePositive(input.actor.credentialEpoch) ||
      !isSafeNonNegative(input.actor.securityFloor) ||
      !identifier.test(input.nonce.value) ||
      !sha256.test(input.nonce.fingerprint) ||
      !validReceiptTTL(
        input.nowSeconds,
        input.nonce.expiresAtSeconds,
        ownerVaultMaximumSecurityReceiptTTLSeconds,
      ) ||
      !identifier.test(input.capability.jti) ||
      !validReceiptTTL(
        input.nowSeconds,
        input.capability.expiresAtSeconds,
        ownerVaultMaximumSecurityReceiptTTLSeconds,
      )
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(read(tx, address("operation-receipt", input.operationID), decodeReceipt)),
        Effect.flatMap((receipt) => {
          if (receipt !== undefined) {
            if (receipt.kind !== "append" || receipt.fingerprint !== input.fingerprint)
              return fail("replay_conflict");
            const sequence = receipt.result.logSequence;
            const payloadHash = receipt.result.payloadHash;
            return isSafePositive(sequence) &&
              typeof payloadHash === "string" &&
              sha256.test(payloadHash)
              ? Effect.succeed({
                  operationID: input.operationID,
                  payloadHash,
                  logSequence: sequence,
                  replayed: true,
                })
              : fail("state_corrupt");
          }
          return authenticatedDevice(tx, input.actor).pipe(
            Effect.zipRight(
              Effect.all([
                getHead(tx),
                read(tx, address("operation-index", input.operationID), decodeOperationIndex),
                read(tx, address("nonce", input.nonce.value), decodeNonce),
                read(tx, address("jti", input.capability.jti), decodeJtiClaim),
                read(tx, address("capability-receipt", input.capability.jti), decodeCapability),
                getAdmission(tx),
              ]),
            ),
            Effect.flatMap(([head, index, nonce, jti, capabilityReceipt, admission]) => {
              if (index !== undefined)
                return index.fingerprint === input.fingerprint
                  ? fail("state_corrupt")
                  : fail("replay_conflict");
              if (input.observedHighWater > head.appendLogSequence)
                return fail("observed_high_water_ahead");
              if (nonce !== undefined && nonce.expiresAtSeconds > input.nowSeconds)
                return fail("nonce_replayed");
              if (jti !== undefined && jti.expiresAtSeconds > input.nowSeconds)
                return fail("capability_replayed");
              if (
                capabilityReceipt !== undefined &&
                capabilityReceipt.expiresAtSeconds > input.nowSeconds
              )
                return fail("capability_replayed");
              if (admission.capabilityReceipts >= ownerVaultMaximumCapabilityReceipts)
                return fail("quota_exceeded");
              const logSequence = head.appendLogSequence + 1;
              if (!isSafePositive(logSequence)) return fail("quota_exceeded");
              const acknowledgement = {
                operationID: input.operationID,
                payloadHash: input.payloadHash,
                logSequence,
                replayed: false,
              } satisfies OwnerVaultAppendAcknowledgement;
              const entry: OwnerVaultAppendLogEntry = {
                operationID: input.operationID,
                fingerprint: input.fingerprint,
                payloadHash: input.payloadHash,
                payloadBase64: input.payloadBase64,
                source: input.source,
                deviceID: input.actor.deviceID,
                logSequence,
              };
              const nextHead = ownerVaultAppendProofNext(root, head, entry);
              if (nextHead === undefined) return fail("state_corrupt");
              return write(tx, address("nonce", input.nonce.value), {
                expiresAtSeconds: input.nonce.expiresAtSeconds,
                fingerprint: input.nonce.fingerprint,
              }).pipe(
                Effect.zipRight(
                  write(tx, address("jti", input.capability.jti), {
                    operationID: input.operationID,
                    expiresAtSeconds: input.capability.expiresAtSeconds,
                  }),
                ),
                Effect.zipRight(
                  write(tx, address("capability-receipt", input.capability.jti), {
                    operationID: input.operationID,
                    expiresAtSeconds: input.capability.expiresAtSeconds,
                    fingerprint: input.fingerprint,
                    result: { logSequence, payloadHash: input.payloadHash },
                  }),
                ),
                Effect.zipRight(
                  write(tx, address("append-log.entry", sequenceID(logSequence)), { ...entry }),
                ),
                Effect.zipRight(
                  write(tx, address("operation-index", input.operationID), {
                    logSequence,
                    fingerprint: input.fingerprint,
                    payloadHash: input.payloadHash,
                  }),
                ),
                Effect.zipRight(
                  write(tx, address("operation-receipt", input.operationID), {
                    kind: "append",
                    fingerprint: input.fingerprint,
                    expiresAtSeconds: input.receiptExpiresAtSeconds,
                    result: { logSequence, payloadHash: input.payloadHash },
                  }),
                ),
                Effect.zipRight(write(tx, address("root.log-head"), { ...nextHead })),
                Effect.zipRight(write(tx, address("append-log.head"), { ...nextHead })),
                Effect.zipRight(
                  write(tx, address("root.admission"), {
                    ...admission,
                    capabilityReceipts: admission.capabilityReceipts + 1,
                  }),
                ),
                Effect.as(acknowledgement),
              );
            }),
          );
        }),
      ),
    );
  };
  const establishSession: OwnerVaultDomainProvider["establishSession"] = (session) => {
    if (decodeSession(session) === undefined) return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(authenticatedDevice(tx, session)),
        Effect.zipRight(getAdmission(tx)),
        Effect.flatMap((admission) =>
          read(tx, address("session", session.sessionID), decodeSession).pipe(
            Effect.flatMap((existing) => {
              if (existing !== undefined)
                return sameSession(existing, session)
                  ? Effect.succeed(existing)
                  : fail("replay_conflict");
              if (admission.activeSessions >= ownerVaultMaximumSessions)
                return fail("quota_exceeded");
              return read(
                tx,
                address("resume", session.resumeTokenHash),
                (value): string | undefined =>
                  isRecord(value) &&
                  exact(value, ["sessionID"]) &&
                  typeof value.sessionID === "string" &&
                  identifier.test(value.sessionID)
                    ? value.sessionID
                    : undefined,
              ).pipe(
                Effect.flatMap((resume) =>
                  resume === undefined
                    ? write(tx, address("session", session.sessionID), { ...session }).pipe(
                        Effect.zipRight(
                          write(tx, address("resume", session.resumeTokenHash), {
                            sessionID: session.sessionID,
                          }),
                        ),
                        Effect.zipRight(
                          write(tx, address("root.admission"), {
                            ...admission,
                            activeSessions: admission.activeSessions + 1,
                          }),
                        ),
                        Effect.as(session),
                      )
                    : fail("replay_conflict"),
                ),
              );
            }),
          ),
        ),
      ),
    );
  };
  const consumeRate: OwnerVaultDomainProvider["consumeRate"] = (input) => {
    if (
      !identifier.test(input.sessionID) ||
      !isSafeNonNegative(input.nowMilliseconds) ||
      !isSafePositive(input.maximumFramesPerMinute)
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(read(tx, address("session", input.sessionID), decodeSession)),
        Effect.flatMap((session) => {
          if (session === undefined) return fail("session_not_found");
          if (session.assertionExpiresAtMilliseconds <= input.nowMilliseconds)
            return fail("session_expired");
          return authenticatedDevice(tx, session).pipe(
            Effect.zipRight(read(tx, address("rate-window", input.sessionID), decodeRate)),
            Effect.flatMap((prior) => {
              const window =
                prior === undefined || input.nowMilliseconds - prior.startedAtMilliseconds >= 60_000
                  ? { startedAtMilliseconds: input.nowMilliseconds, count: 0 }
                  : prior;
              if (window.count >= input.maximumFramesPerMinute) return fail("rate_limited");
              return write(tx, address("rate-window", input.sessionID), {
                startedAtMilliseconds: window.startedAtMilliseconds,
                count: window.count + 1,
              }).pipe(Effect.as(session));
            }),
          );
        }),
      ),
    );
  };
  const deactivateSession: OwnerVaultDomainProvider["deactivateSession"] = (input) => {
    if (
      !identifier.test(input.sessionID) ||
      !identifier.test(input.deviceID) ||
      !isSafePositive(input.authEpoch) ||
      !isSafePositive(input.credentialEpoch)
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(
          Effect.all([
            read(tx, address("session", input.sessionID), decodeSession),
            getAdmission(tx),
          ]),
        ),
        Effect.flatMap(([session, admission]) => {
          if (session === undefined) return Effect.void;
          if (
            session.deviceID !== input.deviceID ||
            session.authEpoch !== input.authEpoch ||
            session.credentialEpoch !== input.credentialEpoch
          )
            return fail("authorization_denied");
          return remove(tx, address("session", input.sessionID)).pipe(
            Effect.zipRight(remove(tx, address("resume", session.resumeTokenHash))),
            Effect.zipRight(remove(tx, address("rate-window", input.sessionID))),
            Effect.zipRight(
              write(tx, address("root.admission"), {
                ...admission,
                activeSessions: Math.max(0, admission.activeSessions - 1),
              }),
            ),
          );
        }),
      ),
    );
  };
  const expireSession = (
    sessionID: string,
    nowMilliseconds: number,
  ): Effect.Effect<boolean, OwnerVaultDomainError> => {
    if (!identifier.test(sessionID) || !isSafeNonNegative(nowMilliseconds))
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(
          Effect.all([read(tx, address("session", sessionID), decodeSession), getAdmission(tx)]),
        ),
        Effect.flatMap(([session, admission]) => {
          if (session === undefined || session.assertionExpiresAtMilliseconds > nowMilliseconds)
            return Effect.succeed(false);
          return remove(tx, address("session", sessionID)).pipe(
            Effect.zipRight(remove(tx, address("resume", session.resumeTokenHash))),
            Effect.zipRight(remove(tx, address("rate-window", sessionID))),
            Effect.zipRight(
              write(tx, address("root.admission"), {
                ...admission,
                activeSessions: Math.max(0, admission.activeSessions - 1),
              }),
            ),
            Effect.as(true),
          );
        }),
      ),
    );
  };
  const expireCapability = (
    jti: string,
    nowSeconds: number,
  ): Effect.Effect<boolean, OwnerVaultDomainError> => {
    if (!identifier.test(jti) || !isSafeNonNegative(nowSeconds)) return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(
          Effect.all([
            read(tx, address("jti", jti), decodeJtiClaim),
            read(tx, address("capability-receipt", jti), decodeCapability),
            getAdmission(tx),
          ]),
        ),
        Effect.flatMap(([jtiClaim, receipt, admission]) => {
          if (jtiClaim === undefined && receipt === undefined) return Effect.succeed(false);
          if (
            jtiClaim === undefined ||
            receipt === undefined ||
            jtiClaim.operationID !== receipt.operationID
          )
            return fail("state_corrupt");
          if (jtiClaim.expiresAtSeconds > nowSeconds || receipt.expiresAtSeconds > nowSeconds)
            return Effect.succeed(false);
          return remove(tx, address("jti", jti)).pipe(
            Effect.zipRight(remove(tx, address("capability-receipt", jti))),
            Effect.zipRight(
              write(tx, address("root.admission"), {
                ...admission,
                capabilityReceipts: Math.max(0, admission.capabilityReceipts - 1),
              }),
            ),
            Effect.as(true),
          );
        }),
      ),
    );
  };
  return Object.freeze({
    initialize,
    issueChallenge,
    readChallenge,
    registerDevice,
    getDevice,
    revokeDevice,
    append,
    establishSession,
    consumeRate,
    deactivateSession,
    expireSession,
    expireCapability,
  });
};

const sameSession = (left: OwnerVaultSessionRecord, right: OwnerVaultSessionRecord): boolean =>
  left.sessionID === right.sessionID &&
  left.deviceID === right.deviceID &&
  left.authEpoch === right.authEpoch &&
  left.credentialEpoch === right.credentialEpoch &&
  left.securityFloor === right.securityFloor &&
  left.assertionExpiresAtMilliseconds === right.assertionExpiresAtMilliseconds &&
  left.resumeTokenHash === right.resumeTokenHash;
