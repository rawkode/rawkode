/** @enchiridion/effect-module */
import { type CanonicalJSON, canonicalJSONStringify, sha256Hex } from "@enchiridion/protocol";
import { Data, Effect } from "effect";
import {
  type OwnerVaultAppendProof,
  ownerVaultAppendProofD0,
  ownerVaultAppendProofNext,
} from "./append-proof";
import {
  type OwnerVaultControlLeaseIndexEntry,
  validOwnerVaultControlLeaseIndexEntry,
} from "./control-operation";
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
const maximumCapabilityReceiptClaimsBytes = 8_192;

export const ownerVaultMaximumDevices = 256;
export const ownerVaultMaximumOutstandingChallenges = 64;
export const ownerVaultMaximumSessions = 64;
/** The singleton expiry index is deliberately resident and never scanned. */
export const ownerVaultMaximumCapabilityReceipts = 64;
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
  /** Present only for rows issued after admission-v2 migration. */
  readonly provenance?: "indexed-v1";
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
  /** Full receipt identity; raw signed bearer material is never persisted. */
  readonly capability: {
    readonly jti: string;
    readonly expiresAtSeconds: number;
    readonly resource: string;
    /** Canonical verified claims; it contains no bearer material. */
    readonly claims: string;
    readonly claimsFingerprint: string;
    readonly tokenFingerprint: string;
  };
}

/**
 * A bounded durable receipt for every verified capability. Claims are stored
 * as canonical non-bearer JSON and the token is represented only by its
 * fingerprint. Endpoint journals may use PREPARED to resume work after an
 * isolate loss; a completed receipt returns its exact canonical result.
 */
export interface OwnerVaultCapabilityReceiptInput {
  readonly jti: string;
  readonly resource: string;
  readonly operationID: string;
  readonly nowSeconds: number;
  readonly expiresAtSeconds: number;
  readonly claims: string;
  readonly claimsFingerprint: string;
  readonly tokenFingerprint: string;
}

export interface OwnerVaultCapabilityReceipt {
  readonly state: "PREPARED" | "COMPLETED";
  readonly jti: string;
  readonly resource: string;
  readonly operationID: string;
  readonly expiresAtSeconds: number;
  readonly claims: string;
  readonly claimsFingerprint: string;
  readonly tokenFingerprint: string;
  readonly result: Readonly<Record<string, unknown>> | undefined;
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
  /** Reaps at most one bounded cursor page and returns the next alarm instant. */
  readonly expireCapabilities: (
    nowSeconds: number,
  ) => Effect.Effect<number | undefined, OwnerVaultDomainError>;
  /**
   * P06-R alarm reclamation for unconsumed device challenges. It walks only
   * the resident admission expiry index (never a storage scan), deletes each
   * expired challenge row by exact key, restores the exact activeChallenges
   * unit the issue transaction consumed, and returns the earliest remaining
   * expiry in milliseconds for the next alarm.
   */
  readonly expireChallenges: (
    nowMilliseconds: number,
  ) => Effect.Effect<number | undefined, OwnerVaultDomainError>;
  readonly claimCapabilityReceipt: (
    input: OwnerVaultCapabilityReceiptInput,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt, OwnerVaultDomainError>;
  /**
   * Read-only terminal receipt preflight.  It validates the same reciprocal
   * JTI, receipt, receipt-index, and admission invariants as a claim, without
   * arming an alarm or changing durable state.
   */
  readonly readCapabilityReceipt: (
    input: OwnerVaultCapabilityReceiptInput,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt | undefined, OwnerVaultDomainError>;
  readonly completeCapabilityReceipt: (
    input: OwnerVaultCapabilityReceiptInput,
    result: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt, OwnerVaultDomainError>;
  /**
   * Transaction-scoped composition variants of initialize / claim / complete.
   * They run inside one caller-owned repository transaction so a control
   * endpoint can establish the root, its capability receipt, and its durable
   * acknowledgement as a single all-or-nothing native commit. Failures are
   * already mapped into the closed transaction-codec domain, so any error
   * rolls back every staged row of the enclosing transaction.
   */
  readonly initializeInTx: (
    tx: OwnerVaultTx,
  ) => Effect.Effect<void, OwnerVaultStorageTransactionFailure>;
  /**
   * P06-R: the device-challenge row and its activeChallenges quota unit are
   * staged inside a caller-owned transaction, so an endpoint can commit the
   * challenge together with its universal capability receipt and completed
   * result as one all-or-nothing native commit.
   */
  readonly issueChallengeInTx: (
    tx: OwnerVaultTx,
    challenge: OwnerVaultChallenge,
    nowMilliseconds: number,
  ) => Effect.Effect<OwnerVaultChallenge, OwnerVaultStorageTransactionFailure>;
  /**
   * Atomically creates a device challenge and completes its capability
   * receipt.  The creator bit is deliberately internal: callers receive
   * only a completed durable receipt, never a persistable replay marker.
   */
  readonly issueChallengeWithCapabilityReceiptInTx: (
    tx: OwnerVaultTx,
    input: OwnerVaultCapabilityReceiptInput,
    challenge: OwnerVaultChallenge,
    result: Readonly<Record<string, unknown>>,
    nowMilliseconds: number,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt, OwnerVaultStorageTransactionFailure>;
  /**
   * The device-completion boundary: capability claim/JTI, challenge
   * consumption, device and idempotency rows, and the completed exact result
   * are one native transaction.  A completed receipt is returned unchanged.
   */
  readonly registerDeviceWithCapabilityReceiptInTx: (
    tx: OwnerVaultTx,
    capability: OwnerVaultCapabilityReceiptInput,
    input: {
      readonly registrationID: string;
      readonly proofFingerprint: string;
      readonly challengeID: string;
      readonly device: OwnerVaultDevice;
      readonly nowMilliseconds: number;
    },
    result: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt, OwnerVaultStorageTransactionFailure>;
  readonly claimCapabilityReceiptInTx: (
    tx: OwnerVaultTx,
    input: OwnerVaultCapabilityReceiptInput,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt, OwnerVaultStorageTransactionFailure>;
  readonly completeCapabilityReceiptInTx: (
    tx: OwnerVaultTx,
    input: OwnerVaultCapabilityReceiptInput,
    result: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<OwnerVaultCapabilityReceipt, OwnerVaultStorageTransactionFailure>;
}

interface Admission {
  readonly schema: "admission-v2" | "admission-v3";
  /** total is deliberately duplicated as a cheap corruption tripwire. */
  readonly total: number;
  readonly activeChallenges: number;
  readonly legacyOutstandingChallenges: number;
  readonly activeDevices: number;
  readonly activeSessions: number;
  readonly capabilityReceipts: number;
  /** v3 only: bounded lease-fenced control operations, never generic receipts. */
  readonly controlReceiptLeases: number;
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
  /** One entry per nonterminal C2 operation. It is static, bounded, and
   * ordered so recovery never performs a namespace scan. */
  /** The C2 index is structured: every writer must preserve all expiry
   * fields so an alarm never has to rediscover an opaque operation. */
  readonly controlReceiptLeasesIndex: readonly OwnerVaultControlLeaseIndexEntry[];
  /** P06-R: the resident expiry index for every unconsumed device challenge.
   * One entry exists exactly while a challenge holds one activeChallenges
   * quota unit, so alarm reclamation restores exact counts without a scan. */
  readonly outstandingChallenges: readonly OwnerVaultChallengeIndexEntry[];
}
interface OwnerVaultChallengeIndexEntry {
  readonly challengeID: string;
  readonly expiresAtMilliseconds: number;
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
type CapabilityReceipt = OwnerVaultCapabilityReceipt;
interface CapabilityReceiptIndexEntry {
  readonly jti: string;
  readonly expiresAtSeconds: number;
}
interface CapabilityReceiptIndex {
  readonly cursor: number;
  readonly entries: readonly CapabilityReceiptIndexEntry[];
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
/** Strict UTF-16 code-unit comparator. The storage-registry index validators
 * accept only this ordering, so index writers must never substitute locale
 * collation: the two disagree for legal identifier pairs (case, '-' vs '_'). */
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
/**
 * Exact recursive canonical-JSON narrowers. They rebuild a fresh value from
 * checked fields instead of asserting, and accept exactly the domain that
 * `canonicalJSONStringify` serializes: null, booleans, finite numbers,
 * strings, dense arrays, and Object-prototype plain objects, recursively.
 */
const canonicalJSONValue = (value: unknown): CanonicalJSON | undefined => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: CanonicalJSON[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return undefined;
      const item = canonicalJSONValue(value[index]);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return items;
  }
  return canonicalJSONRecord(value);
};
const canonicalJSONRecord = (
  value: unknown,
): Readonly<Record<string, CanonicalJSON>> | undefined => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return undefined;
  const entries: [string, CanonicalJSON][] = [];
  for (const [key, child] of Object.entries(value)) {
    const rebuilt = canonicalJSONValue(child);
    if (rebuilt === undefined) return undefined;
    entries.push([key, rebuilt]);
  }
  return Object.fromEntries(entries);
};
const canonicalClaims = (value: unknown): Readonly<Record<string, CanonicalJSON>> | undefined => {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maximumCapabilityReceiptClaimsBytes
  )
    return undefined;
  try {
    const rebuilt = canonicalJSONRecord(JSON.parse(value));
    return rebuilt !== undefined && canonicalJSONStringify(rebuilt) === value ? rebuilt : undefined;
  } catch {
    return undefined;
  }
};
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
    !(
      exact(value, [
        "challengeAudience",
        "challengeBase64",
        "challengeID",
        "consumed",
        "devicePublicKey",
        "expiresAtMilliseconds",
      ]) ||
      exact(value, [
        "challengeAudience",
        "challengeBase64",
        "challengeID",
        "consumed",
        "devicePublicKey",
        "expiresAtMilliseconds",
        "provenance",
      ])
    )
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
    typeof value.consumed === "boolean" &&
    (value.provenance === undefined || value.provenance === "indexed-v1")
    ? {
        challengeID: value.challengeID,
        challengeBase64: value.challengeBase64,
        challengeAudience: value.challengeAudience,
        devicePublicKey: value.devicePublicKey,
        expiresAtMilliseconds: value.expiresAtMilliseconds,
        consumed: value.consumed,
        ...(value.provenance === "indexed-v1" ? { provenance: "indexed-v1" as const } : {}),
      }
    : undefined;
};
const decodeAdmission = (value: unknown): Admission | undefined => {
  if (!isRecord(value)) return undefined;
  const v2 = exact(value, [
    "activeChallenges",
    "activeDevices",
    "activeSessions",
    "activeSocketAdmissions",
    "capabilityReceipts",
    "legacyOutstandingChallenges",
    "pendingSocketAdmissions",
    "schema",
    "stopped",
    "total",
  ]);
  if (v2) {
    if (
      value.schema !== "admission-v2" ||
      !isSafeNonNegative(value.total) ||
      !isSafeNonNegative(value.activeChallenges) ||
      value.total !== value.activeChallenges ||
      !isSafeNonNegative(value.legacyOutstandingChallenges) ||
      value.legacyOutstandingChallenges > value.activeChallenges ||
      !isSafeNonNegative(value.activeDevices) ||
      !isSafeNonNegative(value.activeSessions) ||
      !isSafeNonNegative(value.capabilityReceipts) ||
      !isSafeNonNegative(value.pendingSocketAdmissions) ||
      !isSafeNonNegative(value.activeSocketAdmissions) ||
      typeof value.stopped !== "boolean"
    )
      return undefined;
    return {
      schema: "admission-v2",
      total: value.total,
      activeChallenges: value.activeChallenges,
      legacyOutstandingChallenges: value.legacyOutstandingChallenges,
      activeDevices: value.activeDevices,
      activeSessions: value.activeSessions,
      capabilityReceipts: value.capabilityReceipts,
      controlReceiptLeases: 0,
      stopped: value.stopped,
      pendingSocketAdmissions: value.pendingSocketAdmissions,
      activeSocketAdmissions: value.activeSocketAdmissions,
      // Index values are loaded transactionally by getAdmission.
      preparedSocketOperationIDs: [],
      socketReplayJTIs: [],
      controlReceiptLeasesIndex: [],
      outstandingChallenges: [],
    };
  }
  const v3 = exact(value, [
    "activeChallenges",
    "activeDevices",
    "activeSessions",
    "activeSocketAdmissions",
    "capabilityReceipts",
    "controlReceiptLeases",
    "legacyOutstandingChallenges",
    "pendingSocketAdmissions",
    "schema",
    "stopped",
    "total",
  ]);
  if (v3) {
    if (
      value.schema !== "admission-v3" ||
      !isSafeNonNegative(value.total) ||
      !isSafeNonNegative(value.activeChallenges) ||
      value.total !== value.activeChallenges ||
      !isSafeNonNegative(value.legacyOutstandingChallenges) ||
      value.legacyOutstandingChallenges > value.activeChallenges ||
      !isSafeNonNegative(value.activeDevices) ||
      !isSafeNonNegative(value.activeSessions) ||
      !isSafeNonNegative(value.capabilityReceipts) ||
      !isSafeNonNegative(value.controlReceiptLeases) ||
      value.controlReceiptLeases > 64 ||
      !isSafeNonNegative(value.pendingSocketAdmissions) ||
      !isSafeNonNegative(value.activeSocketAdmissions) ||
      typeof value.stopped !== "boolean"
    )
      return undefined;
    return {
      schema: "admission-v3",
      total: value.total,
      activeChallenges: value.activeChallenges,
      legacyOutstandingChallenges: value.legacyOutstandingChallenges,
      activeDevices: value.activeDevices,
      activeSessions: value.activeSessions,
      capabilityReceipts: value.capabilityReceipts,
      controlReceiptLeases: value.controlReceiptLeases,
      stopped: value.stopped,
      pendingSocketAdmissions: value.pendingSocketAdmissions,
      activeSocketAdmissions: value.activeSocketAdmissions,
      preparedSocketOperationIDs: [],
      socketReplayJTIs: [],
      controlReceiptLeasesIndex: [],
      outstandingChallenges: [],
    };
  }
  const legacyKeys = new Set([
    "activeChallenges",
    "activeDevices",
    "activeSessions",
    "capabilityReceipts",
    "stopped",
    "pendingSocketAdmissions",
    "activeSocketAdmissions",
    "preparedSocketOperationIDs",
    "socketReplayJTIs",
    "outstandingChallenges",
  ]);
  if (
    !Object.keys(value).every((key) => legacyKeys.has(key)) ||
    !isSafeNonNegative(value.activeChallenges) ||
    !isSafeNonNegative(value.activeDevices) ||
    !isSafeNonNegative(value.activeSessions) ||
    !isSafeNonNegative(value.capabilityReceipts) ||
    (value.stopped !== undefined && typeof value.stopped !== "boolean") ||
    (value.pendingSocketAdmissions !== undefined &&
      !isSafeNonNegative(value.pendingSocketAdmissions)) ||
    (value.activeSocketAdmissions !== undefined && !isSafeNonNegative(value.activeSocketAdmissions))
  )
    return undefined;
  const challenges = decodeChallengeIndexEntries(value.outstandingChallenges);
  const ids = (input: unknown): readonly string[] | undefined => {
    if (!Array.isArray(input) || input.length > ownerVaultMaximumSessions) return undefined;
    const entries: string[] = [];
    for (const entry of input) {
      if (typeof entry !== "string" || !identifier.test(entry)) return undefined;
      entries.push(entry);
    }
    return new Set(entries).size === entries.length ? entries : undefined;
  };
  const prepared =
    value.preparedSocketOperationIDs === undefined ? [] : ids(value.preparedSocketOperationIDs);
  const replay = value.socketReplayJTIs === undefined ? [] : ids(value.socketReplayJTIs);
  if (
    challenges === undefined ||
    prepared === undefined ||
    replay === undefined ||
    challenges.length > value.activeChallenges
  )
    return undefined;
  return {
    schema: "admission-v2",
    total: value.activeChallenges,
    activeChallenges: value.activeChallenges,
    legacyOutstandingChallenges: value.activeChallenges - challenges.length,
    activeDevices: value.activeDevices,
    activeSessions: value.activeSessions,
    capabilityReceipts: value.capabilityReceipts,
    controlReceiptLeases: 0,
    stopped: value.stopped === true,
    pendingSocketAdmissions: value.pendingSocketAdmissions ?? 0,
    activeSocketAdmissions: value.activeSocketAdmissions ?? 0,
    preparedSocketOperationIDs: prepared,
    socketReplayJTIs: replay,
    controlReceiptLeasesIndex: [],
    outstandingChallenges: challenges,
  };
};
/** Re-projects an already-typed structure as a storage payload without asserting. */
const materializeRecord = (
  value: Readonly<Record<string, unknown>> | Admission,
): Readonly<Record<string, unknown>> => Object.fromEntries(Object.entries(value));
/**
 * Distinguishes a fully materialized in-memory Admission (schema plus every
 * resident index array) from a plain payload that must round-trip through the
 * exact admission decoder before it may be persisted.
 */
const isMaterializedAdmission = (
  value: Readonly<Record<string, unknown>> | Admission,
): value is Admission =>
  (value.schema === "admission-v2" || value.schema === "admission-v3") &&
  Array.isArray(value.outstandingChallenges) &&
  Array.isArray(value.preparedSocketOperationIDs) &&
  Array.isArray(value.socketReplayJTIs) &&
  Array.isArray(value.controlReceiptLeasesIndex);
/** Exact rebuild of a bounded identifier list singleton index. */
const decodeIdentifierEntries = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry: unknown = value[index];
    if (typeof entry !== "string" || !identifier.test(entry)) return undefined;
    entries.push(entry);
  }
  return entries;
};
/** Exact bounded rebuild of the sorted C2 lease index. */
const decodeControlLeaseEntries = (
  value: unknown,
): readonly OwnerVaultControlLeaseIndexEntry[] | undefined => {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const entries: OwnerVaultControlLeaseIndexEntry[] = [];
  let previous: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry: unknown = value[index];
    if (!validOwnerVaultControlLeaseIndexEntry(entry)) return undefined;
    // Strict ordering also proves uniqueness without a second pass.
    if (previous !== undefined && !(previous < entry.operationID)) return undefined;
    previous = entry.operationID;
    entries.push(entry);
  }
  return entries;
};
/** Exact bounded rebuild of the resident unconsumed-challenge expiry index. */
const decodeChallengeIndexEntries = (
  value: unknown,
): readonly OwnerVaultChallengeIndexEntry[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ownerVaultMaximumOutstandingChallenges)
    return undefined;
  const entries: OwnerVaultChallengeIndexEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    const source: unknown = value[index];
    if (
      !isRecord(source) ||
      !exact(source, ["challengeID", "expiresAtMilliseconds"]) ||
      typeof source.challengeID !== "string" ||
      !identifier.test(source.challengeID) ||
      !isSafePositive(source.expiresAtMilliseconds)
    )
      return undefined;
    entries.push({
      challengeID: source.challengeID,
      expiresAtMilliseconds: source.expiresAtMilliseconds,
    });
  }
  return new Set(entries.map((entry) => entry.challengeID)).size === entries.length
    ? entries
    : undefined;
};
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
    ? {
        appendLogSequence: value.appendLogSequence,
        appendLogDigest: value.appendLogDigest,
      }
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
    ? {
        expiresAtSeconds: value.expiresAtSeconds,
        fingerprint: value.fingerprint,
      }
    : undefined;
/**
 * The persisted claims must bind the receipt identity, not merely share a
 * digest: the JTI, the signed expiry, and (when the verifier bound a request
 * path) the resource must all equal the fields under the claims fingerprint.
 * Socket sync receipts persist DO-synthesized canonical claims without a
 * `path` member; every verifier-produced claims record carries one.
 */
const boundCanonicalClaims = (input: OwnerVaultCapabilityReceiptInput): boolean => {
  const claims = canonicalClaims(input.claims);
  return (
    claims !== undefined &&
    claims.jti === input.jti &&
    claims.expiresAt === input.expiresAtSeconds &&
    (claims.path === undefined || claims.path === input.resource)
  );
};
const validCapabilityReceiptInput = (input: OwnerVaultCapabilityReceiptInput): boolean =>
  identifier.test(input.jti) &&
  /^\/[A-Za-z0-9_./-]{1,192}$/u.test(input.resource) &&
  identifier.test(input.operationID) &&
  isSafeNonNegative(input.nowSeconds) &&
  validReceiptTTL(
    input.nowSeconds,
    input.expiresAtSeconds,
    ownerVaultMaximumSecurityReceiptTTLSeconds,
  ) &&
  boundCanonicalClaims(input) &&
  sha256.test(input.claimsFingerprint) &&
  sha256Hex(new TextEncoder().encode(input.claims)) === input.claimsFingerprint &&
  sha256.test(input.tokenFingerprint);
const validCanonicalResult = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false;
  try {
    const rebuilt = canonicalJSONRecord(value);
    return (
      rebuilt !== undefined &&
      new TextEncoder().encode(canonicalJSONStringify(rebuilt)).byteLength <=
        maximumCapabilityReceiptClaimsBytes
    );
  } catch {
    return false;
  }
};
const sameCanonicalResult = (
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean => {
  try {
    const leftRebuilt = canonicalJSONRecord(left);
    const rightRebuilt = canonicalJSONRecord(right);
    return (
      leftRebuilt !== undefined &&
      rightRebuilt !== undefined &&
      canonicalJSONStringify(leftRebuilt) === canonicalJSONStringify(rightRebuilt)
    );
  } catch {
    return false;
  }
};
const deviceRegistrationResultDevice = (
  result: Readonly<Record<string, unknown>>,
  ownerID: string,
): Pick<OwnerVaultDevice, "deviceID" | "authEpoch"> | undefined =>
  exact(result, ["authEpoch", "deviceID", "ownerID", "protocolVersion"]) &&
  typeof result.protocolVersion === "number" &&
  Number.isSafeInteger(result.protocolVersion) &&
  result.protocolVersion > 0 &&
  result.ownerID === ownerID &&
  typeof result.deviceID === "string" &&
  identifier.test(result.deviceID) &&
  isSafePositive(result.authEpoch)
    ? { deviceID: result.deviceID, authEpoch: result.authEpoch }
    : undefined;
const deviceRegistrationResultMatches = (
  result: Readonly<Record<string, unknown>>,
  ownerID: string,
  device: OwnerVaultDevice,
): boolean => {
  const registered = deviceRegistrationResultDevice(result, ownerID);
  return (
    registered !== undefined &&
    registered.deviceID === device.deviceID &&
    registered.authEpoch === device.authEpoch
  );
};
const sameDevice = (left: OwnerVaultDevice, right: OwnerVaultDevice): boolean =>
  left.deviceID === right.deviceID &&
  left.publicKeySPKI === right.publicKeySPKI &&
  left.authEpoch === right.authEpoch &&
  left.credentialEpoch === right.credentialEpoch &&
  left.revoked === right.revoked &&
  left.securityFloor === right.securityFloor;
const sameCapabilityReceipt = (
  receipt: CapabilityReceipt,
  input: OwnerVaultCapabilityReceiptInput,
): boolean =>
  receipt.jti === input.jti &&
  receipt.resource === input.resource &&
  receipt.operationID === input.operationID &&
  receipt.expiresAtSeconds === input.expiresAtSeconds &&
  receipt.claims === input.claims &&
  receipt.claimsFingerprint === input.claimsFingerprint &&
  receipt.tokenFingerprint === input.tokenFingerprint;
const capabilityReceipt = (
  input: OwnerVaultCapabilityReceiptInput,
  state: OwnerVaultCapabilityReceipt["state"],
  result: OwnerVaultCapabilityReceipt["result"],
): OwnerVaultCapabilityReceipt => ({
  state,
  jti: input.jti,
  resource: input.resource,
  operationID: input.operationID,
  expiresAtSeconds: input.expiresAtSeconds,
  claims: input.claims,
  claimsFingerprint: input.claimsFingerprint,
  tokenFingerprint: input.tokenFingerprint,
  result,
});
const decodeCapability = (value: unknown): CapabilityReceipt | undefined => {
  if (!isRecord(value)) return undefined;
  const prepared = exact(value, [
    "claimsFingerprint",
    "claims",
    "expiresAtSeconds",
    "jti",
    "operationID",
    "resource",
    "state",
    "tokenFingerprint",
  ]);
  const completed = exact(value, [
    "claimsFingerprint",
    "claims",
    "expiresAtSeconds",
    "jti",
    "operationID",
    "resource",
    "result",
    "state",
    "tokenFingerprint",
  ]);
  if (
    (!prepared && !completed) ||
    (value.state !== "PREPARED" && value.state !== "COMPLETED") ||
    (value.state === "PREPARED" && !prepared) ||
    (value.state === "COMPLETED" && !completed) ||
    typeof value.jti !== "string" ||
    typeof value.resource !== "string" ||
    typeof value.operationID !== "string" ||
    typeof value.expiresAtSeconds !== "number" ||
    typeof value.claims !== "string" ||
    typeof value.claimsFingerprint !== "string" ||
    typeof value.tokenFingerprint !== "string"
  )
    return undefined;
  const input = {
    jti: value.jti,
    resource: value.resource,
    operationID: value.operationID,
    nowSeconds: value.expiresAtSeconds - 1,
    expiresAtSeconds: value.expiresAtSeconds,
    claims: value.claims,
    claimsFingerprint: value.claimsFingerprint,
    tokenFingerprint: value.tokenFingerprint,
  } satisfies OwnerVaultCapabilityReceiptInput;
  if (!validCapabilityReceiptInput(input)) return undefined;
  if (value.state === "PREPARED") return capabilityReceipt(input, "PREPARED", undefined);
  return validCanonicalResult(value.result)
    ? capabilityReceipt(input, "COMPLETED", value.result)
    : undefined;
};
const capabilityIndexSortKey = (entry: CapabilityReceiptIndexEntry): string =>
  `${entry.expiresAtSeconds.toString().padStart(12, "0")}/${entry.jti}`;
const decodeCapabilityIndex = (value: unknown): CapabilityReceiptIndex | undefined => {
  if (
    !isRecord(value) ||
    !exact(value, ["cursor", "entries"]) ||
    !isSafeNonNegative(value.cursor) ||
    !Array.isArray(value.entries) ||
    value.entries.length > ownerVaultMaximumCapabilityReceipts
  )
    return undefined;
  const entries: CapabilityReceiptIndexEntry[] = [];
  let previous = "";
  for (const source of value.entries) {
    if (
      !isRecord(source) ||
      !exact(source, ["expiresAtSeconds", "jti"]) ||
      typeof source.jti !== "string" ||
      !identifier.test(source.jti) ||
      !isSafePositive(source.expiresAtSeconds)
    )
      return undefined;
    const entry = {
      jti: source.jti,
      expiresAtSeconds: source.expiresAtSeconds,
    };
    const key = capabilityIndexSortKey(entry);
    if (previous !== "" && previous >= key) return undefined;
    previous = key;
    entries.push(entry);
  }
  return entries.length === 0
    ? value.cursor === 0
      ? { cursor: 0, entries }
      : undefined
    : value.cursor < entries.length
      ? { cursor: value.cursor, entries }
      : undefined;
};
const decodeJtiClaim = (value: unknown): JtiClaim | undefined =>
  isRecord(value) &&
  exact(value, ["expiresAtSeconds", "operationID"]) &&
  isSafePositive(value.expiresAtSeconds) &&
  typeof value.operationID === "string" &&
  identifier.test(value.operationID)
    ? {
        expiresAtSeconds: value.expiresAtSeconds,
        operationID: value.operationID,
      }
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
    payload: Readonly<Record<string, unknown>> | Admission,
  ) => {
    if (target.category !== "root.admission")
      return tx.put(target, materializeRecord(payload)).pipe(Effect.mapError(storageFailure));
    const admission = isMaterializedAdmission(payload) ? payload : decodeAdmission(payload);
    if (admission === undefined) return fail<void>("state_corrupt");
    const rootPayload = {
      schema: "admission-v3",
      total: admission.activeChallenges,
      activeChallenges: admission.activeChallenges,
      legacyOutstandingChallenges: admission.legacyOutstandingChallenges,
      activeDevices: admission.activeDevices,
      activeSessions: admission.activeSessions,
      capabilityReceipts: admission.capabilityReceipts,
      controlReceiptLeases: admission.controlReceiptLeasesIndex.length,
      pendingSocketAdmissions: admission.pendingSocketAdmissions,
      activeSocketAdmissions: admission.activeSocketAdmissions,
      stopped: admission.stopped,
    } as const;
    const challenges = [...admission.outstandingChallenges].sort((left, right) =>
      left.expiresAtMilliseconds === right.expiresAtMilliseconds
        ? compareCodeUnits(left.challengeID, right.challengeID)
        : left.expiresAtMilliseconds - right.expiresAtMilliseconds,
    );
    return tx.put(target, rootPayload).pipe(
      Effect.mapError(storageFailure),
      Effect.zipRight(
        tx
          .put({ category: "challenge-expiry-index" }, { entries: challenges })
          .pipe(Effect.mapError(storageFailure)),
      ),
      Effect.zipRight(
        tx
          .put(
            { category: "socket-prepared-index" },
            { entries: admission.preparedSocketOperationIDs },
          )
          .pipe(Effect.mapError(storageFailure)),
      ),
      Effect.zipRight(
        tx
          .put({ category: "socket-replay-index" }, { entries: admission.socketReplayJTIs })
          .pipe(Effect.mapError(storageFailure)),
      ),
      Effect.zipRight(
        tx
          .put(
            { category: "control-receipt-lease-index" },
            {
              entries: [...admission.controlReceiptLeasesIndex].sort((left, right) =>
                compareCodeUnits(left.operationID, right.operationID),
              ),
            },
          )
          .pipe(Effect.mapError(storageFailure)),
      ),
    );
  };
  const remove = (tx: OwnerVaultTx, target: OwnerVaultStorageAddress) =>
    tx.delete(target).pipe(Effect.mapError(storageFailure));
  /**
   * Expiry/lease reclamation must keep working after a credential fence. The
   * identity is still immutable; only admission of new caller work is stopped.
   */
  const requireRootIdentity = (tx: OwnerVaultTx): Effect.Effect<void, OwnerVaultDomainError> =>
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
            ? Effect.void
            : fail("identity_conflict"),
      ),
    );
  const requireRoot = (tx: OwnerVaultTx): Effect.Effect<void, OwnerVaultDomainError> =>
    requireRootIdentity(tx).pipe(
      Effect.zipRight(getAdmission(tx)),
      Effect.flatMap((admission) =>
        admission.stopped ? fail("authorization_denied") : Effect.void,
      ),
    );
  const getAdmission = (tx: OwnerVaultTx) =>
    Effect.all([
      read(tx, address("root.admission"), decodeAdmission),
      read(tx, address("challenge-expiry-index"), (value) =>
        isRecord(value) ? decodeChallengeIndexEntries(value.entries) : undefined,
      ),
      read(tx, address("socket-prepared-index"), (value) =>
        isRecord(value) ? decodeIdentifierEntries(value.entries) : undefined,
      ),
      read(tx, address("socket-replay-index"), (value) =>
        isRecord(value) ? decodeIdentifierEntries(value.entries) : undefined,
      ),
      read(tx, address("control-receipt-lease-index"), (value) =>
        isRecord(value) ? decodeControlLeaseEntries(value.entries) : undefined,
      ),
    ]).pipe(
      Effect.flatMap(([value, challenges, prepared, replay, controlLeases]) => {
        if (value === undefined) return fail<Admission>("state_corrupt");
        const legacy = challenges === undefined && prepared === undefined && replay === undefined;
        if (value.schema === "admission-v2" && controlLeases !== undefined)
          return fail<Admission>("state_corrupt");
        if (value.schema === "admission-v3" && controlLeases === undefined)
          return fail<Admission>("state_corrupt");
        if (!legacy && (challenges === undefined || prepared === undefined || replay === undefined))
          return fail<Admission>("state_corrupt");
        const next: Admission =
          challenges === undefined || prepared === undefined || replay === undefined
            ? value
            : {
                ...value,
                outstandingChallenges: challenges,
                preparedSocketOperationIDs: prepared,
                socketReplayJTIs: replay,
                controlReceiptLeasesIndex: controlLeases ?? [],
              };
        if (
          next.activeChallenges !==
          next.outstandingChallenges.length + next.legacyOutstandingChallenges
        )
          return fail<Admission>("state_corrupt");
        if (
          next.schema === "admission-v3" &&
          next.controlReceiptLeases !== next.controlReceiptLeasesIndex.length
        )
          return fail<Admission>("state_corrupt");
        // Reads may decode the legacy root for compatibility, but are never
        // allowed to materialize it. The next state-changing writer commits
        // root and every singleton index together in its native transaction.
        return Effect.succeed(next);
      }),
    );
  const assertAdmissionIndexes = (
    admission: Admission,
    receipts: CapabilityReceiptIndex,
  ): Effect.Effect<void, OwnerVaultDomainError> =>
    admission.capabilityReceipts !== receipts.entries.length ||
    admission.activeChallenges !==
      admission.outstandingChallenges.length + admission.legacyOutstandingChallenges
      ? fail("state_corrupt")
      : Effect.void;
  /**
   * The DO has only one alarm.  A domain is therefore allowed to tighten it,
   * but never to clear or delay another domain's earlier deadline.
   */
  const armSharedAlarmInTx = (
    tx: OwnerVaultTx,
    admission: Admission,
    receipts: CapabilityReceiptIndex,
  ): Effect.Effect<void, OwnerVaultDomainError> => {
    const capabilityDeadline = receipts.entries[0]?.expiresAtSeconds;
    if (capabilityDeadline !== undefined && !Number.isSafeInteger(capabilityDeadline * 1_000))
      return fail("state_corrupt");
    const challengeDeadline = admission.outstandingChallenges.reduce<number | undefined>(
      (nearest, entry) =>
        nearest === undefined
          ? entry.expiresAtMilliseconds
          : Math.min(nearest, entry.expiresAtMilliseconds),
      undefined,
    );
    const deadline =
      capabilityDeadline === undefined
        ? challengeDeadline
        : challengeDeadline === undefined
          ? capabilityDeadline * 1_000
          : Math.min(capabilityDeadline * 1_000, challengeDeadline);
    if (deadline === undefined) return Effect.void;
    return tx.getAlarm().pipe(
      Effect.mapError(storageFailure),
      Effect.flatMap((current) =>
        current === null || current > deadline
          ? tx.setAlarm(deadline).pipe(Effect.mapError(storageFailure))
          : Effect.void,
      ),
    );
  };
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

  const initializeBody = (tx: OwnerVaultTx): Effect.Effect<void, OwnerVaultDomainError> => {
    const initialAppendDigest = ownerVaultAppendProofD0(root);
    if (initialAppendDigest === undefined) return fail("invalid_input");
    return tx.initialize(root).pipe(
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
              outstandingChallenges: [],
            })
          : Effect.void,
      ),
      Effect.zipRight(read(tx, address("capability-receipt-index"), decodeCapabilityIndex)),
      Effect.flatMap((index) =>
        index === undefined
          ? write(tx, address("capability-receipt-index"), {
              cursor: 0,
              entries: [],
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
              appendLogDigest: initialAppendDigest,
            })
          : Effect.void,
      ),
      Effect.zipRight(read(tx, address("append-log.head"), decodeLogHead)),
      Effect.flatMap((head) =>
        head === undefined
          ? write(tx, address("append-log.head"), {
              appendLogSequence: 0,
              appendLogDigest: initialAppendDigest,
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
    );
  };
  const initialize = (): Effect.Effect<void, OwnerVaultDomainError> => {
    // The scope guard stays ahead of the transaction so an invalid root is
    // reported as invalid_input exactly as before, without opening a commit.
    const initialAppendDigest = ownerVaultAppendProofD0(root);
    if (initialAppendDigest === undefined) return fail("invalid_input");
    return transact(initializeBody);
  };
  const initializeInTx: OwnerVaultDomainProvider["initializeInTx"] = (tx) =>
    initializeBody(tx).pipe(Effect.mapError(transactionFailure));

  const issueChallengeBody = (
    tx: OwnerVaultTx,
    challenge: OwnerVaultChallenge,
    nowMilliseconds: number,
  ): Effect.Effect<OwnerVaultChallenge, OwnerVaultDomainError> => {
    if (
      decodeChallenge(challenge) === undefined ||
      !isSafeNonNegative(nowMilliseconds) ||
      challenge.expiresAtMilliseconds <= nowMilliseconds
    )
      return fail("invalid_input");
    return requireRoot(tx).pipe(
      Effect.zipRight(
        Effect.all([
          getAdmission(tx),
          read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
        ]),
      ),
      Effect.flatMap(([admission, receiptIndex]) =>
        receiptIndex === undefined
          ? fail<OwnerVaultChallenge>("state_corrupt")
          : assertAdmissionIndexes(admission, receiptIndex).pipe(
              Effect.zipRight(
                read(tx, address("device-challenge", challenge.challengeID), decodeChallenge).pipe(
                  Effect.flatMap((existing) => {
                    if (existing !== undefined) return fail<OwnerVaultChallenge>("already_exists");
                    if (
                      admission.outstandingChallenges.some(
                        (entry) => entry.challengeID === challenge.challengeID,
                      )
                    )
                      return fail<OwnerVaultChallenge>("state_corrupt");
                    if (
                      admission.activeChallenges >= ownerVaultMaximumOutstandingChallenges ||
                      admission.outstandingChallenges.length >=
                        ownerVaultMaximumOutstandingChallenges
                    )
                      return fail<OwnerVaultChallenge>("quota_exceeded");
                    const nextAdmission: Admission = {
                      ...admission,
                      activeChallenges: admission.activeChallenges + 1,
                      outstandingChallenges: [
                        ...admission.outstandingChallenges,
                        {
                          challengeID: challenge.challengeID,
                          expiresAtMilliseconds: challenge.expiresAtMilliseconds,
                        },
                      ],
                    };
                    return write(tx, address("device-challenge", challenge.challengeID), {
                      ...challenge,
                      provenance: "indexed-v1",
                    }).pipe(
                      Effect.zipRight(
                        write(tx, address("root.admission"), {
                          ...nextAdmission,
                        }),
                      ),
                      Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, receiptIndex)),
                      Effect.as(challenge),
                    );
                  }),
                ),
              ),
            ),
      ),
    );
  };
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
    return transact((tx) => issueChallengeBody(tx, challenge, nowMilliseconds));
  };
  const issueChallengeInTx: OwnerVaultDomainProvider["issueChallengeInTx"] = (
    tx,
    challenge,
    nowMilliseconds,
  ) => issueChallengeBody(tx, challenge, nowMilliseconds).pipe(Effect.mapError(transactionFailure));
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
  const registerDeviceBody = (
    tx: OwnerVaultTx,
    input: {
      readonly registrationID: string;
      readonly proofFingerprint: string;
      readonly challengeID: string;
      readonly device: OwnerVaultDevice;
      readonly nowMilliseconds: number;
    },
  ): Effect.Effect<
    { readonly device: OwnerVaultDevice; readonly replayed: boolean },
    OwnerVaultDomainError
  > => {
    if (
      !identifier.test(input.registrationID) ||
      !sha256.test(input.proofFingerprint) ||
      !identifier.test(input.challengeID) ||
      decodeDevice(input.device) === undefined ||
      !isSafeNonNegative(input.nowMilliseconds)
    )
      return fail("invalid_input");
    return requireRoot(tx).pipe(
      Effect.zipRight(read(tx, address("operation-receipt", input.registrationID), decodeReceipt)),
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
          read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
          read(tx, address("device-challenge", input.challengeID), decodeChallenge),
          read(tx, address("device", input.device.deviceID), decodeDevice),
        ]).pipe(
          Effect.flatMap(([admission, receiptIndex, challenge, existingDevice]) => {
            if (receiptIndex === undefined) return fail("state_corrupt");
            const challengeIndex = admission.outstandingChallenges.find(
              (entry) => entry.challengeID === input.challengeID,
            );
            if (
              admission.activeChallenges !==
                admission.outstandingChallenges.length + admission.legacyOutstandingChallenges ||
              admission.capabilityReceipts !== receiptIndex.entries.length
            )
              return fail("state_corrupt");
            if (challenge === undefined) return fail("challenge_not_found");
            if (challenge.expiresAtMilliseconds <= input.nowMilliseconds)
              return fail("challenge_expired");
            if (challenge.consumed) return fail("challenge_consumed");
            if (
              challenge.devicePublicKey !== input.device.publicKeySPKI ||
              existingDevice !== undefined
            )
              return fail("authorization_denied");
            if (admission.activeDevices >= ownerVaultMaximumDevices) return fail("quota_exceeded");
            if (admission.activeChallenges < 1) return fail("state_corrupt");
            const indexed = challengeIndex !== undefined;
            if (
              indexed &&
              (challenge.provenance !== "indexed-v1" ||
                challenge.challengeID !== challengeIndex.challengeID ||
                challenge.expiresAtMilliseconds !== challengeIndex.expiresAtMilliseconds)
            )
              return fail("state_corrupt");
            if (
              !indexed &&
              (challenge.provenance !== undefined || admission.legacyOutstandingChallenges < 1)
            )
              return fail("state_corrupt");
            const nextChallenges = admission.outstandingChallenges.filter(
              (entry) => entry.challengeID !== input.challengeID,
            );
            if (indexed && nextChallenges.length !== admission.outstandingChallenges.length - 1)
              return fail("state_corrupt");
            const consumed: OwnerVaultChallenge = {
              ...challenge,
              consumed: true,
            };
            const result = { device: input.device };
            return write(tx, address("device-challenge", input.challengeID), {
              ...consumed,
            }).pipe(
              Effect.zipRight(
                write(tx, address("device", input.device.deviceID), {
                  ...input.device,
                }),
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
                  activeChallenges: admission.activeChallenges - 1,
                  legacyOutstandingChallenges:
                    admission.legacyOutstandingChallenges - (indexed ? 0 : 1),
                  // Consumption releases the quota unit, so the resident
                  // expiry index entry leaves in the same commit.
                  outstandingChallenges: nextChallenges,
                }),
              ),
              Effect.as({ device: input.device, replayed: false }),
            );
          }),
        );
      }),
    );
  };
  const registerDevice: OwnerVaultDomainProvider["registerDevice"] = (input) =>
    transact((tx) => registerDeviceBody(tx, input));
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
              return write(tx, address("device", target.deviceID), {
                ...revoked,
              }).pipe(
                Effect.zipRight(
                  write(tx, address("root.floors"), {
                    securityFloor: nextFloor,
                  }),
                ),
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
      !validCapabilityReceiptInput({
        jti: input.capability.jti,
        resource: input.capability.resource,
        operationID: input.operationID,
        nowSeconds: input.nowSeconds,
        expiresAtSeconds: input.capability.expiresAtSeconds,
        claims: input.capability.claims,
        claimsFingerprint: input.capability.claimsFingerprint,
        tokenFingerprint: input.capability.tokenFingerprint,
      })
    )
      return fail("invalid_input");
    return transact((tx) =>
      requireRoot(tx).pipe(
        Effect.zipRight(
          Effect.all([
            read(tx, address("operation-receipt", input.operationID), decodeReceipt),
            read(tx, address("jti", input.capability.jti), decodeJtiClaim),
            read(tx, address("capability-receipt", input.capability.jti), decodeCapability),
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
          ]),
        ),
        Effect.flatMap(
          ([receipt, priorJti, priorCapabilityReceipt, outerAdmission, outerIndex]) => {
            if (
              outerIndex === undefined ||
              outerAdmission.capabilityReceipts !== outerIndex.entries.length ||
              outerAdmission.activeChallenges !==
                outerAdmission.outstandingChallenges.length +
                  outerAdmission.legacyOutstandingChallenges
            )
              return fail("state_corrupt");
            if (receipt !== undefined) {
              // An operation receipt is never an authorization shortcut. A
              // still-live JTI must name this exact operation and capability
              // receipt before it may replay the acknowledgement.
              if (
                priorJti !== undefined &&
                priorJti.expiresAtSeconds > input.nowSeconds &&
                (priorJti.operationID !== input.operationID ||
                  priorCapabilityReceipt === undefined ||
                  priorCapabilityReceipt.expiresAtSeconds <= input.nowSeconds ||
                  priorCapabilityReceipt.operationID !== input.operationID)
              )
                return fail("capability_replayed");
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
                  getAdmission(tx),
                  read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
                ]),
              ),
              Effect.flatMap(([head, index, nonce, admission, receiptIndex]) => {
                if (receiptIndex === undefined) return fail("state_corrupt");
                if (
                  admission.capabilityReceipts !== receiptIndex.entries.length ||
                  admission.activeChallenges !==
                    admission.outstandingChallenges.length + admission.legacyOutstandingChallenges
                )
                  return fail("state_corrupt");
                if (index !== undefined)
                  return index.fingerprint === input.fingerprint
                    ? fail("state_corrupt")
                    : fail("replay_conflict");
                if (input.observedHighWater > head.appendLogSequence)
                  return fail("observed_high_water_ahead");
                if (nonce !== undefined && nonce.expiresAtSeconds > input.nowSeconds)
                  return fail("nonce_replayed");
                if (
                  priorJti !== undefined ||
                  priorCapabilityReceipt !== undefined ||
                  receiptIndex.entries.some((entry) => entry.jti === input.capability.jti)
                )
                  return fail("state_corrupt");
                if (
                  admission.capabilityReceipts >= ownerVaultMaximumCapabilityReceipts ||
                  receiptIndex.entries.length >= ownerVaultMaximumCapabilityReceipts
                )
                  return fail("quota_exceeded");
                if (head.appendLogSequence >= Number.MAX_SAFE_INTEGER)
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
                const nextReceiptIndex = {
                  cursor: 0,
                  entries: [
                    ...receiptIndex.entries,
                    {
                      jti: input.capability.jti,
                      expiresAtSeconds: input.capability.expiresAtSeconds,
                    },
                  ].sort((left, right) =>
                    compareCodeUnits(capabilityIndexSortKey(left), capabilityIndexSortKey(right)),
                  ),
                } satisfies CapabilityReceiptIndex;
                const nextAdmission = {
                  ...admission,
                  capabilityReceipts: admission.capabilityReceipts + 1,
                };
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
                      state: "COMPLETED",
                      jti: input.capability.jti,
                      resource: input.capability.resource,
                      operationID: input.operationID,
                      expiresAtSeconds: input.capability.expiresAtSeconds,
                      claims: input.capability.claims,
                      claimsFingerprint: input.capability.claimsFingerprint,
                      tokenFingerprint: input.capability.tokenFingerprint,
                      result: {
                        logSequence,
                        payloadHash: input.payloadHash,
                      },
                    }),
                  ),
                  Effect.zipRight(write(tx, address("capability-receipt-index"), nextReceiptIndex)),
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
                      result: {
                        logSequence,
                        payloadHash: input.payloadHash,
                      },
                    }),
                  ),
                  Effect.zipRight(write(tx, address("root.log-head"), { ...nextHead })),
                  Effect.zipRight(write(tx, address("append-log.head"), { ...nextHead })),
                  Effect.zipRight(write(tx, address("root.admission"), nextAdmission)),
                  Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, nextReceiptIndex)),
                  Effect.as(acknowledgement),
                );
              }),
            );
          },
        ),
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
                    ? write(tx, address("session", session.sessionID), {
                        ...session,
                      }).pipe(
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
          if (admission.activeSessions < 1) return fail("state_corrupt");
          return remove(tx, address("session", input.sessionID)).pipe(
            Effect.zipRight(remove(tx, address("resume", session.resumeTokenHash))),
            Effect.zipRight(remove(tx, address("rate-window", input.sessionID))),
            Effect.zipRight(
              write(tx, address("root.admission"), {
                ...admission,
                activeSessions: admission.activeSessions - 1,
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
          if (admission.activeSessions < 1) return fail("state_corrupt");
          return remove(tx, address("session", sessionID)).pipe(
            Effect.zipRight(remove(tx, address("resume", session.resumeTokenHash))),
            Effect.zipRight(remove(tx, address("rate-window", sessionID))),
            Effect.zipRight(
              write(tx, address("root.admission"), {
                ...admission,
                activeSessions: admission.activeSessions - 1,
              }),
            ),
            Effect.as(true),
          );
        }),
      ),
    );
  };
  const claimCapabilityReceiptBody = (
    tx: OwnerVaultTx,
    input: OwnerVaultCapabilityReceiptInput,
  ): Effect.Effect<
    { readonly receipt: CapabilityReceipt; readonly creator: boolean },
    OwnerVaultDomainError
  > => {
    if (!validCapabilityReceiptInput(input)) return fail("invalid_input");
    return requireRootIdentity(tx).pipe(
      Effect.zipRight(
        Effect.all([
          read(tx, address("jti", input.jti), decodeJtiClaim),
          read(tx, address("capability-receipt", input.jti), decodeCapability),
          getAdmission(tx),
          read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
        ]),
      ),
      Effect.flatMap(([jtiClaim, receipt, admission, receiptIndex]) => {
        if (receiptIndex === undefined)
          return fail<{
            readonly receipt: CapabilityReceipt;
            readonly creator: boolean;
          }>("state_corrupt");
        const invariant = assertAdmissionIndexes(admission, receiptIndex);
        const indexed = receiptIndex.entries.some(
          (entry) => entry.jti === input.jti && entry.expiresAtSeconds === input.expiresAtSeconds,
        );
        if (jtiClaim === undefined && receipt === undefined) {
          // A fence stops new admission, but a durable pre-fence receipt
          // may be read/reconciled exactly after a lost response. Its
          // endpoint-specific journal still revalidates before mutation.
          if (admission.stopped)
            return fail<{
              readonly receipt: CapabilityReceipt;
              readonly creator: boolean;
            }>("authorization_denied");
          if (indexed)
            return fail<{
              readonly receipt: CapabilityReceipt;
              readonly creator: boolean;
            }>("state_corrupt");
          if (
            admission.capabilityReceipts >= ownerVaultMaximumCapabilityReceipts ||
            receiptIndex.entries.length >= ownerVaultMaximumCapabilityReceipts
          )
            return fail<{
              readonly receipt: CapabilityReceipt;
              readonly creator: boolean;
            }>("quota_exceeded");
          const nextIndex = {
            cursor: 0,
            entries: [
              ...receiptIndex.entries,
              { jti: input.jti, expiresAtSeconds: input.expiresAtSeconds },
            ].sort((left, right) =>
              compareCodeUnits(capabilityIndexSortKey(left), capabilityIndexSortKey(right)),
            ),
          } satisfies CapabilityReceiptIndex;
          const prepared = capabilityReceipt(input, "PREPARED", undefined);
          const nextAdmission = {
            ...admission,
            capabilityReceipts: admission.capabilityReceipts + 1,
          };
          return invariant.pipe(
            Effect.zipRight(
              write(tx, address("jti", input.jti), {
                operationID: input.operationID,
                expiresAtSeconds: input.expiresAtSeconds,
              }),
            ),
            Effect.zipRight(
              write(tx, address("capability-receipt", input.jti), {
                state: prepared.state,
                jti: prepared.jti,
                resource: prepared.resource,
                operationID: prepared.operationID,
                expiresAtSeconds: prepared.expiresAtSeconds,
                claims: prepared.claims,
                claimsFingerprint: prepared.claimsFingerprint,
                tokenFingerprint: prepared.tokenFingerprint,
              }),
            ),
            Effect.zipRight(write(tx, address("capability-receipt-index"), nextIndex)),
            Effect.zipRight(write(tx, address("root.admission"), nextAdmission)),
            Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, nextIndex)),
            Effect.as({ receipt: prepared, creator: true }),
          );
        }
        if (
          jtiClaim === undefined ||
          receipt === undefined ||
          !indexed ||
          jtiClaim.operationID !== input.operationID ||
          jtiClaim.expiresAtSeconds !== input.expiresAtSeconds ||
          !sameCapabilityReceipt(receipt, input)
        )
          return fail<{
            readonly receipt: CapabilityReceipt;
            readonly creator: boolean;
          }>("replay_conflict");
        return invariant.pipe(
          Effect.zipRight(armSharedAlarmInTx(tx, admission, receiptIndex)),
          Effect.as({ receipt, creator: false }),
        );
      }),
    );
  };
  const claimCapabilityReceipt: OwnerVaultDomainProvider["claimCapabilityReceipt"] = (input) => {
    if (!validCapabilityReceiptInput(input)) return fail("invalid_input");
    return transact((tx) =>
      claimCapabilityReceiptBody(tx, input).pipe(Effect.map((value) => value.receipt)),
    );
  };
  const readCapabilityReceipt: OwnerVaultDomainProvider["readCapabilityReceipt"] = (input) => {
    if (!validCapabilityReceiptInput(input)) return fail("invalid_input");
    return transact((tx) =>
      requireRootIdentity(tx).pipe(
        Effect.zipRight(
          Effect.all([
            read(tx, address("jti", input.jti), decodeJtiClaim),
            read(tx, address("capability-receipt", input.jti), decodeCapability),
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
          ]),
        ),
        Effect.flatMap(([jtiClaim, receipt, admission, receiptIndex]) => {
          if (receiptIndex === undefined)
            return fail<OwnerVaultCapabilityReceipt | undefined>("state_corrupt");
          const entriesForJTI = receiptIndex.entries.filter((entry) => entry.jti === input.jti);
          const indexed =
            entriesForJTI.length === 1 &&
            entriesForJTI[0]?.expiresAtSeconds === input.expiresAtSeconds;
          return assertAdmissionIndexes(admission, receiptIndex).pipe(
            Effect.zipRight(
              jtiClaim === undefined && receipt === undefined && entriesForJTI.length === 0
                ? Effect.succeed(undefined)
                : jtiClaim === undefined ||
                    receipt === undefined ||
                    !indexed ||
                    jtiClaim.operationID !== input.operationID ||
                    jtiClaim.expiresAtSeconds !== input.expiresAtSeconds ||
                    !sameCapabilityReceipt(receipt, input)
                  ? fail<OwnerVaultCapabilityReceipt | undefined>("state_corrupt")
                  : Effect.succeed(receipt),
            ),
          );
        }),
      ),
    );
  };
  const claimCapabilityReceiptInTx: OwnerVaultDomainProvider["claimCapabilityReceiptInTx"] = (
    tx,
    input,
  ) =>
    claimCapabilityReceiptBody(tx, input).pipe(
      Effect.map((value) => value.receipt),
      Effect.mapError(transactionFailure),
    );
  const completeCapabilityReceiptBody = (
    tx: OwnerVaultTx,
    input: OwnerVaultCapabilityReceiptInput,
    result: Readonly<Record<string, unknown>>,
  ): Effect.Effect<CapabilityReceipt, OwnerVaultDomainError> => {
    if (!validCapabilityReceiptInput(input) || !validCanonicalResult(result))
      return fail("invalid_input");
    return requireRootIdentity(tx).pipe(
      Effect.zipRight(
        Effect.all([
          read(tx, address("jti", input.jti), decodeJtiClaim),
          read(tx, address("capability-receipt", input.jti), decodeCapability),
          getAdmission(tx),
          read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
        ]),
      ),
      Effect.flatMap(([jtiClaim, receipt, admission, receiptIndex]) => {
        if (
          jtiClaim === undefined ||
          receipt === undefined ||
          receiptIndex === undefined ||
          !receiptIndex.entries.some(
            (entry) => entry.jti === input.jti && entry.expiresAtSeconds === input.expiresAtSeconds,
          ) ||
          jtiClaim.operationID !== input.operationID ||
          jtiClaim.expiresAtSeconds !== input.expiresAtSeconds ||
          !sameCapabilityReceipt(receipt, input)
        )
          return fail<CapabilityReceipt>("replay_conflict");
        if (receipt.state === "COMPLETED")
          return receipt.result !== undefined && sameCanonicalResult(receipt.result, result)
            ? assertAdmissionIndexes(admission, receiptIndex).pipe(
                Effect.zipRight(armSharedAlarmInTx(tx, admission, receiptIndex)),
                Effect.as(receipt),
              )
            : fail<CapabilityReceipt>("replay_conflict");
        const completed = capabilityReceipt(input, "COMPLETED", result);
        return assertAdmissionIndexes(admission, receiptIndex).pipe(
          Effect.zipRight(
            write(tx, address("capability-receipt", input.jti), {
              state: completed.state,
              jti: completed.jti,
              resource: completed.resource,
              operationID: completed.operationID,
              expiresAtSeconds: completed.expiresAtSeconds,
              claims: completed.claims,
              claimsFingerprint: completed.claimsFingerprint,
              tokenFingerprint: completed.tokenFingerprint,
              result: completed.result,
            }),
          ),
          Effect.zipRight(armSharedAlarmInTx(tx, admission, receiptIndex)),
          Effect.as(completed),
        );
      }),
    );
  };
  const completeCapabilityReceipt: OwnerVaultDomainProvider["completeCapabilityReceipt"] = (
    input,
    result,
  ) => {
    if (!validCapabilityReceiptInput(input) || !validCanonicalResult(result))
      return fail("invalid_input");
    return transact((tx) => completeCapabilityReceiptBody(tx, input, result));
  };
  const completeCapabilityReceiptInTx: OwnerVaultDomainProvider["completeCapabilityReceiptInTx"] = (
    tx,
    input,
    result,
  ) => completeCapabilityReceiptBody(tx, input, result).pipe(Effect.mapError(transactionFailure));
  const issueChallengeWithCapabilityReceiptInTx: OwnerVaultDomainProvider["issueChallengeWithCapabilityReceiptInTx"] =
    (tx, input, challenge, result, nowMilliseconds) => {
      if (
        !validCapabilityReceiptInput(input) ||
        decodeChallenge(challenge) === undefined ||
        !isSafeNonNegative(nowMilliseconds) ||
        challenge.expiresAtMilliseconds <= nowMilliseconds ||
        !validCanonicalResult(result)
      )
        return fail<OwnerVaultCapabilityReceipt>("invalid_input").pipe(
          Effect.mapError(transactionFailure),
        );
      // Do not compose the ordinary claim/issue/complete helpers here: DO
      // transactions intentionally do not offer a read-your-own-write
      // guarantee between separately staged repository helpers.  This is the
      // one complete row-set calculation for the endpoint boundary.
      return requireRoot(tx).pipe(
        Effect.zipRight(
          Effect.all([
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
            read(tx, address("jti", input.jti), decodeJtiClaim),
            read(tx, address("capability-receipt", input.jti), decodeCapability),
            read(tx, address("device-challenge", challenge.challengeID), decodeChallenge),
          ]),
        ),
        Effect.flatMap(([admission, receiptIndex, jti, receipt, existingChallenge]) => {
          if (receiptIndex === undefined) return fail<CapabilityReceipt>("state_corrupt");
          if (jti !== undefined || receipt !== undefined) {
            return jti !== undefined &&
              receipt !== undefined &&
              receipt.state === "COMPLETED" &&
              receipt.result !== undefined &&
              jti.operationID === input.operationID &&
              jti.expiresAtSeconds === input.expiresAtSeconds &&
              sameCapabilityReceipt(receipt, input) &&
              receiptIndex.entries.some(
                (entry) =>
                  entry.jti === input.jti && entry.expiresAtSeconds === input.expiresAtSeconds,
              )
              ? assertAdmissionIndexes(admission, receiptIndex).pipe(Effect.as(receipt))
              : fail<CapabilityReceipt>("replay_conflict");
          }
          if (
            admission.stopped ||
            existingChallenge !== undefined ||
            admission.capabilityReceipts !== receiptIndex.entries.length ||
            admission.activeChallenges !==
              admission.outstandingChallenges.length + admission.legacyOutstandingChallenges ||
            receiptIndex.entries.some((entry) => entry.jti === input.jti) ||
            admission.outstandingChallenges.some(
              (entry) => entry.challengeID === challenge.challengeID,
            ) ||
            admission.capabilityReceipts >= ownerVaultMaximumCapabilityReceipts ||
            admission.activeChallenges >= ownerVaultMaximumOutstandingChallenges ||
            admission.outstandingChallenges.length >= ownerVaultMaximumOutstandingChallenges
          )
            return fail<CapabilityReceipt>("state_corrupt");
          const nextReceiptIndex = {
            cursor: 0,
            entries: [
              ...receiptIndex.entries,
              { jti: input.jti, expiresAtSeconds: input.expiresAtSeconds },
            ].sort((left, right) =>
              compareCodeUnits(capabilityIndexSortKey(left), capabilityIndexSortKey(right)),
            ),
          } satisfies CapabilityReceiptIndex;
          const nextAdmission: Admission = {
            ...admission,
            capabilityReceipts: admission.capabilityReceipts + 1,
            activeChallenges: admission.activeChallenges + 1,
            outstandingChallenges: [
              ...admission.outstandingChallenges,
              {
                challengeID: challenge.challengeID,
                expiresAtMilliseconds: challenge.expiresAtMilliseconds,
              },
            ],
          };
          const completed = capabilityReceipt(input, "COMPLETED", result);
          return write(tx, address("device-challenge", challenge.challengeID), {
            ...challenge,
            provenance: "indexed-v1",
          }).pipe(
            Effect.zipRight(
              write(tx, address("jti", input.jti), {
                operationID: input.operationID,
                expiresAtSeconds: input.expiresAtSeconds,
              }),
            ),
            Effect.zipRight(
              write(tx, address("capability-receipt", input.jti), {
                ...completed,
              }),
            ),
            Effect.zipRight(write(tx, address("capability-receipt-index"), nextReceiptIndex)),
            Effect.zipRight(write(tx, address("root.admission"), nextAdmission)),
            Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, nextReceiptIndex)),
            Effect.as(completed),
          );
        }),
        Effect.mapError(transactionFailure),
      );
    };
  const registerDeviceWithCapabilityReceiptInTx: OwnerVaultDomainProvider["registerDeviceWithCapabilityReceiptInTx"] =
    (tx, capability, input, result) => {
      if (
        !validCapabilityReceiptInput(capability) ||
        !validCanonicalResult(result) ||
        !identifier.test(input.registrationID) ||
        !sha256.test(input.proofFingerprint) ||
        !identifier.test(input.challengeID) ||
        decodeDevice(input.device) === undefined ||
        !isSafeNonNegative(input.nowMilliseconds)
      )
        return fail<OwnerVaultCapabilityReceipt>("invalid_input").pipe(
          Effect.mapError(transactionFailure),
        );
      // DO transactions do not promise that a helper can observe another
      // helper's staged rows.  Keep this endpoint boundary as one whole-row
      // decision and one commit: it never persists a PREPARED receipt.
      return requireRootIdentity(tx).pipe(
        Effect.zipRight(
          Effect.all([
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
            read(tx, address("jti", capability.jti), decodeJtiClaim),
            read(tx, address("capability-receipt", capability.jti), decodeCapability),
            read(tx, address("device-challenge", input.challengeID), decodeChallenge),
            read(tx, address("device", input.device.deviceID), decodeDevice),
            read(tx, address("operation-receipt", input.registrationID), decodeReceipt),
          ]),
        ),
        Effect.flatMap(
          ([
            admission,
            receiptIndex,
            jtiClaim,
            receipt,
            challenge,
            existingDevice,
            registration,
          ]) => {
            if (receiptIndex === undefined) return fail<CapabilityReceipt>("state_corrupt");
            const indexedReceipt = receiptIndex.entries.some(
              (entry) =>
                entry.jti === capability.jti &&
                entry.expiresAtSeconds === capability.expiresAtSeconds,
            );
            if (jtiClaim !== undefined || receipt !== undefined || indexedReceipt) {
              const terminal =
                jtiClaim !== undefined &&
                receipt !== undefined &&
                indexedReceipt &&
                receipt.state === "COMPLETED" &&
                receipt.result !== undefined &&
                jtiClaim.operationID === capability.operationID &&
                jtiClaim.expiresAtSeconds === capability.expiresAtSeconds &&
                sameCapabilityReceipt(receipt, capability);
              const registered =
                receipt?.result === undefined
                  ? undefined
                  : deviceRegistrationResultDevice(receipt.result, root.ownerID);
              if (!terminal || registered === undefined || registration === undefined)
                return fail<CapabilityReceipt>("replay_conflict");
              return read(tx, address("device", registered.deviceID), decodeDevice).pipe(
                Effect.flatMap((registeredDevice) => {
                  const receiptDevice = decodeDevice(registration.result.device);
                  return registeredDevice === undefined ||
                    registeredDevice.authEpoch !== registered.authEpoch ||
                    receiptDevice === undefined ||
                    registration.kind !== "device-registration" ||
                    registration.fingerprint !== input.proofFingerprint ||
                    !sameDevice(registeredDevice, receiptDevice) ||
                    challenge === undefined ||
                    !challenge.consumed ||
                    challenge.devicePublicKey !== registeredDevice.publicKeySPKI
                    ? fail<CapabilityReceipt>("replay_conflict")
                    : assertAdmissionIndexes(admission, receiptIndex).pipe(Effect.as(receipt));
                }),
              );
            }
            if (!deviceRegistrationResultMatches(result, root.ownerID, input.device))
              return fail<CapabilityReceipt>("replay_conflict");
            if (admission.stopped) return fail<CapabilityReceipt>("authorization_denied");
            if (registration !== undefined) return fail<CapabilityReceipt>("replay_conflict");
            if (challenge === undefined) return fail<CapabilityReceipt>("challenge_not_found");
            if (challenge.expiresAtMilliseconds <= input.nowMilliseconds)
              return fail<CapabilityReceipt>("challenge_expired");
            if (challenge.consumed) return fail<CapabilityReceipt>("challenge_consumed");
            if (
              challenge.devicePublicKey !== input.device.publicKeySPKI ||
              existingDevice !== undefined
            )
              return fail<CapabilityReceipt>("authorization_denied");
            const challengeIndex = admission.outstandingChallenges.find(
              (entry) => entry.challengeID === input.challengeID,
            );
            const indexedChallenge = challengeIndex !== undefined;
            if (
              (indexedChallenge &&
                (challenge.provenance !== "indexed-v1" ||
                  challenge.challengeID !== challengeIndex.challengeID ||
                  challenge.expiresAtMilliseconds !== challengeIndex.expiresAtMilliseconds)) ||
              (!indexedChallenge &&
                (challenge.provenance !== undefined ||
                  admission.legacyOutstandingChallenges < 1)) ||
              admission.activeDevices >= ownerVaultMaximumDevices ||
              admission.capabilityReceipts >= ownerVaultMaximumCapabilityReceipts ||
              receiptIndex.entries.length >= ownerVaultMaximumCapabilityReceipts
            )
              return fail<CapabilityReceipt>(
                admission.activeDevices >= ownerVaultMaximumDevices ||
                  admission.capabilityReceipts >= ownerVaultMaximumCapabilityReceipts ||
                  receiptIndex.entries.length >= ownerVaultMaximumCapabilityReceipts
                  ? "quota_exceeded"
                  : "state_corrupt",
              );
            const nextChallenges = admission.outstandingChallenges.filter(
              (entry) => entry.challengeID !== input.challengeID,
            );
            if (
              admission.activeChallenges < 1 ||
              (indexedChallenge &&
                nextChallenges.length !== admission.outstandingChallenges.length - 1)
            )
              return fail<CapabilityReceipt>("state_corrupt");
            const nextReceiptIndex = {
              cursor: 0,
              entries: [
                ...receiptIndex.entries,
                { jti: capability.jti, expiresAtSeconds: capability.expiresAtSeconds },
              ].sort((left, right) =>
                compareCodeUnits(capabilityIndexSortKey(left), capabilityIndexSortKey(right)),
              ),
            } satisfies CapabilityReceiptIndex;
            const nextAdmission: Admission = {
              ...admission,
              activeDevices: admission.activeDevices + 1,
              activeChallenges: admission.activeChallenges - 1,
              capabilityReceipts: admission.capabilityReceipts + 1,
              legacyOutstandingChallenges:
                admission.legacyOutstandingChallenges - (indexedChallenge ? 0 : 1),
              outstandingChallenges: nextChallenges,
            };
            const consumed = { ...challenge, consumed: true } satisfies OwnerVaultChallenge;
            const completed = capabilityReceipt(capability, "COMPLETED", result);
            return assertAdmissionIndexes(admission, receiptIndex).pipe(
              Effect.zipRight(write(tx, address("device-challenge", input.challengeID), consumed)),
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
                  result: { device: input.device },
                }),
              ),
              Effect.zipRight(
                write(tx, address("jti", capability.jti), {
                  operationID: capability.operationID,
                  expiresAtSeconds: capability.expiresAtSeconds,
                }),
              ),
              Effect.zipRight(
                write(tx, address("capability-receipt", capability.jti), { ...completed }),
              ),
              Effect.zipRight(write(tx, address("capability-receipt-index"), nextReceiptIndex)),
              Effect.zipRight(write(tx, address("root.admission"), nextAdmission)),
              Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, nextReceiptIndex)),
              Effect.as(completed),
            );
          },
        ),
        Effect.mapError(transactionFailure),
      );
    };
  const expireCapability = (
    jti: string,
    nowSeconds: number,
  ): Effect.Effect<boolean, OwnerVaultDomainError> => {
    if (!identifier.test(jti) || !isSafeNonNegative(nowSeconds)) return fail("invalid_input");
    return transact((tx) =>
      requireRootIdentity(tx).pipe(
        Effect.zipRight(
          Effect.all([
            read(tx, address("jti", jti), decodeJtiClaim),
            read(tx, address("capability-receipt", jti), decodeCapability),
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
          ]),
        ),
        Effect.flatMap(([jtiClaim, receipt, admission, receiptIndex]) => {
          if (receiptIndex === undefined) return fail("state_corrupt");
          if (
            admission.capabilityReceipts !== receiptIndex.entries.length ||
            admission.activeChallenges !==
              admission.outstandingChallenges.length + admission.legacyOutstandingChallenges
          )
            return fail("state_corrupt");
          if (jtiClaim === undefined && receipt === undefined) return Effect.succeed(false);
          if (
            jtiClaim === undefined ||
            receipt === undefined ||
            jtiClaim.operationID !== receipt.operationID ||
            jtiClaim.expiresAtSeconds !== receipt.expiresAtSeconds ||
            receipt.jti !== jti ||
            !receiptIndex.entries.some(
              (entry) => entry.jti === jti && entry.expiresAtSeconds === receipt.expiresAtSeconds,
            )
          )
            return fail("state_corrupt");
          if (jtiClaim.expiresAtSeconds > nowSeconds || receipt.expiresAtSeconds > nowSeconds)
            return Effect.succeed(false);
          if (admission.capabilityReceipts < 1) return fail("state_corrupt");
          const nextEntries = receiptIndex.entries.filter((entry) => entry.jti !== jti);
          if (nextEntries.length !== receiptIndex.entries.length - 1) return fail("state_corrupt");
          return remove(tx, address("jti", jti)).pipe(
            Effect.zipRight(remove(tx, address("capability-receipt", jti))),
            Effect.zipRight(
              write(tx, address("capability-receipt-index"), {
                cursor: nextEntries.length === 0 ? 0 : receiptIndex.cursor % nextEntries.length,
                entries: nextEntries,
              }),
            ),
            Effect.zipRight(
              write(tx, address("root.admission"), {
                ...admission,
                capabilityReceipts: admission.capabilityReceipts - 1,
              }),
            ),
            Effect.as(true),
          );
        }),
      ),
    );
  };
  const expireCapabilities = (
    nowSeconds: number,
  ): Effect.Effect<number | undefined, OwnerVaultDomainError> => {
    if (!isSafeNonNegative(nowSeconds)) return fail("invalid_input");
    return transact((tx) =>
      requireRootIdentity(tx).pipe(
        Effect.zipRight(
          Effect.all([
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
          ]),
        ),
        Effect.flatMap(([admission, index]) => {
          if (index === undefined) return fail<number | undefined>("state_corrupt");
          return assertAdmissionIndexes(admission, index).pipe(
            Effect.zipRight(
              Effect.forEach(index.entries, (entry) =>
                Effect.all([
                  read(tx, address("jti", entry.jti), decodeJtiClaim),
                  read(tx, address("capability-receipt", entry.jti), decodeCapability),
                ]).pipe(
                  Effect.flatMap(([jti, receipt]) =>
                    jti === undefined ||
                    receipt === undefined ||
                    jti.operationID !== receipt.operationID ||
                    jti.expiresAtSeconds !== entry.expiresAtSeconds ||
                    receipt.jti !== entry.jti ||
                    receipt.expiresAtSeconds !== entry.expiresAtSeconds
                      ? fail("state_corrupt")
                      : Effect.void,
                  ),
                ),
              ),
            ),
            Effect.flatMap(() => {
              const expired = index.entries.filter((entry) => entry.expiresAtSeconds <= nowSeconds);
              const remaining = index.entries.filter(
                (entry) => entry.expiresAtSeconds > nowSeconds,
              );
              if (expired.length === 0) return Effect.succeed(remaining[0]?.expiresAtSeconds);
              if (expired.length > admission.capabilityReceipts) return fail("state_corrupt");
              const nextAdmission = {
                ...admission,
                capabilityReceipts: admission.capabilityReceipts - expired.length,
              };
              const nextIndex = {
                cursor: 0,
                entries: remaining,
              } satisfies CapabilityReceiptIndex;
              return Effect.forEach(expired, (entry) =>
                remove(tx, address("jti", entry.jti)).pipe(
                  Effect.zipRight(remove(tx, address("capability-receipt", entry.jti))),
                ),
              ).pipe(
                Effect.zipRight(write(tx, address("capability-receipt-index"), nextIndex)),
                Effect.zipRight(write(tx, address("root.admission"), nextAdmission)),
                Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, nextIndex)),
                Effect.as(remaining[0]?.expiresAtSeconds),
              );
            }),
          );
        }),
      ),
    );
  };
  const expireChallenges = (
    nowMilliseconds: number,
  ): Effect.Effect<number | undefined, OwnerVaultDomainError> => {
    if (!isSafeNonNegative(nowMilliseconds)) return fail("invalid_input");
    return transact((tx) =>
      requireRootIdentity(tx).pipe(
        Effect.zipRight(
          Effect.all([
            getAdmission(tx),
            read(tx, address("capability-receipt-index"), decodeCapabilityIndex),
          ]),
        ),
        Effect.flatMap(([admission, receipts]) => {
          if (receipts === undefined) return fail<number | undefined>("state_corrupt");
          return assertAdmissionIndexes(admission, receipts).pipe(
            Effect.zipRight(
              Effect.forEach(admission.outstandingChallenges, (entry) =>
                read(tx, address("device-challenge", entry.challengeID), decodeChallenge).pipe(
                  Effect.flatMap((challenge) =>
                    challenge === undefined ||
                    challenge.consumed ||
                    challenge.challengeID !== entry.challengeID ||
                    challenge.expiresAtMilliseconds !== entry.expiresAtMilliseconds
                      ? fail("state_corrupt")
                      : Effect.void,
                  ),
                ),
              ),
            ),
            Effect.flatMap(() => {
              const expired = admission.outstandingChallenges.filter(
                (entry) => entry.expiresAtMilliseconds <= nowMilliseconds,
              );
              const remaining = admission.outstandingChallenges.filter(
                (entry) => entry.expiresAtMilliseconds > nowMilliseconds,
              );
              const earliest = remaining.reduce<number | undefined>(
                (nearest, entry) =>
                  nearest === undefined
                    ? entry.expiresAtMilliseconds
                    : Math.min(nearest, entry.expiresAtMilliseconds),
                undefined,
              );
              if (expired.length === 0) return Effect.succeed(earliest);
              if (expired.length > admission.activeChallenges) return fail("state_corrupt");
              const nextAdmission = {
                ...admission,
                activeChallenges: admission.activeChallenges - expired.length,
                outstandingChallenges: remaining,
              };
              return Effect.forEach(expired, (entry) =>
                remove(tx, address("device-challenge", entry.challengeID)),
              ).pipe(
                Effect.zipRight(write(tx, address("root.admission"), nextAdmission)),
                Effect.zipRight(armSharedAlarmInTx(tx, nextAdmission, receipts)),
                Effect.as(earliest),
              );
            }),
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
    expireCapabilities,
    expireChallenges,
    claimCapabilityReceipt,
    readCapabilityReceipt,
    completeCapabilityReceipt,
    initializeInTx,
    issueChallengeInTx,
    issueChallengeWithCapabilityReceiptInTx,
    registerDeviceWithCapabilityReceiptInTx,
    claimCapabilityReceiptInTx,
    completeCapabilityReceiptInTx,
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
