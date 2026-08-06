import type {
  ClientWebSocketFrame,
  ServerHelloChallengeFrame,
  ServerWebSocketFrame,
  SyncChangeFrame,
} from "@enchiridion/protocol";
/** @enchiridion/effect-module */
import type {
  CapabilityClaims,
  CapabilityExpectation,
  CapabilityRequestBinding,
  SignedCapability,
} from "@enchiridion/runtime";
import { Context, Data, Effect } from "effect";

type HelloFrame = Extract<ClientWebSocketFrame, { readonly type: "hello" }>;
type SyncAcknowledgedFrame = Extract<ServerWebSocketFrame, { readonly type: "syncAcknowledged" }>;

/** The only durable binding an OwnerVaultDO may ever adopt. */
export interface OwnerVaultIdentity {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
}

export interface OwnerVaultSession {
  readonly identity: OwnerVaultIdentity;
  readonly deviceID: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly sessionNonce: string;
  readonly assertionExpiresAt: number;
  readonly capabilityJTI: string;
  /**
   * A non-authoritative attachment snapshot. The durable session repository
   * always reloads and computes rate state transactionally; this merely lets a
   * newly serialized attachment describe the committed result.
   */
  readonly rateWindowStartedAtMilliseconds: number;
  /** See `rateWindowStartedAtMilliseconds`: never authorize from this value. */
  readonly rateCount: number;
}

/**
 * A durable session never retains the bearer resume token. It retains only its
 * SHA-256 text digest, which is an opaque storage index rather than a wire
 * value. The raw token is returned exactly once in HelloAccepted.
 */
export interface OwnerVaultDurableSession {
  readonly version: 1;
  readonly session: OwnerVaultSession;
  readonly resumeTokenHash: string;
}

/** JSON attachment format: bounded, serializable, non-secret, and versioned. */
export interface OwnerVaultSocketAttachment {
  readonly version: 1;
  readonly state: "awaitingHello" | "active";
  readonly identity: OwnerVaultIdentity;
  /** Upgrade capability receipt identity, retained only until its bounded expiry. */
  readonly capabilityJTI: string;
  readonly capabilityExpiresAt: number;
  /** Exact server-first challenge that the first client Hello must echo and sign. */
  readonly challenge?: ServerHelloChallengeFrame;
  readonly session?: OwnerVaultSession;
}

export class OwnerVaultSyncError extends Data.TaggedError("OwnerVaultSyncError")<{
  readonly reason:
    | "attachment_invalid"
    | "authorization_denied"
    | "capability_denied"
    | "capability_replayed"
    | "identity_conflict"
    | "invalid_frame"
    | "nonce_replayed"
    | "quota_exceeded"
    | "replay_conflict"
    | "session_expired"
    | "session_invalid"
    | "signature_invalid"
    | "version_unsupported";
}> {}

export interface OwnerVaultCapabilityVerifier {
  readonly verify: (
    signed: SignedCapability,
    binding: CapabilityRequestBinding,
    expected: CapabilityExpectation,
    nowSeconds: number,
  ) => Effect.Effect<CapabilityClaims, OwnerVaultSyncError>;
}

/**
 * JTI receipts are operation scoped: the same capability cannot authorize a
 * different frame. P03-06's durable implementation MUST make a claim made
 * before a surrounding storage/mutation transaction either commit with that
 * transaction or expire as a short transient reservation. A failed attempt
 * must never permanently burn a JTI and deny its identical retry.
 */
export interface OwnerVaultJtiLedger {
  readonly claim: (
    jti: string,
    operation: string,
    expiresAtSeconds: number,
  ) => Effect.Effect<"claimed" | "duplicate", OwnerVaultSyncError>;
  /**
   * Releases only a claim whose surrounding state transaction did not commit.
   * Durable implementations must make this idempotent; if cleanup cannot
   * complete immediately, they retain cleanup-pending state for retry while
   * leaving the caller's original authorization/storage failure authoritative.
   */
  readonly releaseTransient: (
    jti: string,
    operation: string,
  ) => Effect.Effect<void, OwnerVaultSyncError>;
}

export interface OwnerVaultDeviceAuthorizer {
  /**
   * Reads the current vault/device security floors before the server emits its
   * signed challenge. P03-06 supplies the transactional registry provider.
   */
  readonly issueHelloChallenge: (
    identity: OwnerVaultIdentity,
    credentialEpoch: number,
    nowMilliseconds: number,
  ) => Effect.Effect<
    {
      readonly authEpoch: number;
      readonly credentialEpoch: number;
    },
    OwnerVaultSyncError
  >;
  readonly acceptHello: (
    identity: OwnerVaultIdentity,
    frame: HelloFrame,
    signedPayload: Uint8Array,
    nowMilliseconds: number,
  ) => Effect.Effect<
    {
      readonly deviceID: string;
      readonly authEpoch: number;
      readonly credentialEpoch: number;
      readonly assertionExpiresAt: number;
    },
    OwnerVaultSyncError
  >;
  /** Performs canonical low-S signature verification and atomically claims frame nonce/floors. */
  readonly authorizeChange: (
    session: OwnerVaultSession,
    frame: SyncChangeFrame,
    signedPayload: Uint8Array,
    nowMilliseconds: number,
  ) => Effect.Effect<void, OwnerVaultSyncError>;
}

export interface OwnerVaultMutationStore {
  /** Must atomically apply the mutation and write an immutable receipt before ACK. */
  readonly apply: (
    session: OwnerVaultSession,
    frame: SyncChangeFrame,
    nowMilliseconds: number,
  ) => Effect.Effect<SyncAcknowledgedFrame, OwnerVaultSyncError>;
}

/**
 * P03-06's one durable transaction: it rechecks device/binding/floors after
 * signature verification, claims the frame nonce and capability JTI receipt,
 * applies the mutation, and writes the immutable ACK receipt before returning.
 */
export interface OwnerVaultAtomicChange {
  readonly authorizeClaimAndApply: (
    session: OwnerVaultSession,
    frame: SyncChangeFrame,
    signedPayload: Uint8Array,
    nowMilliseconds: number,
  ) => Effect.Effect<SyncAcknowledgedFrame, OwnerVaultSyncError>;
}

export interface OwnerVaultSessionNonce {
  readonly next: () => Effect.Effect<string, OwnerVaultSyncError>;
}

/** The CSPRNG-backed, canonical 256-bit continuation-token issuer. */
export interface OwnerVaultResumeTokenIssuer {
  readonly next: () => Effect.Effect<string, OwnerVaultSyncError>;
}

/**
 * P03-04's local DO storage seam. `establish` rotates a supplied raw resume
 * token atomically, retaining only its digest. `transactFrame` checks/writes a
 * `{frameID, requestHash, result}` receipt in that same storage transaction;
 * P03-06's mutation provider is deliberately evaluated only for a new frame.
 */
export interface OwnerVaultDurableSyncRepository {
  readonly establish: (
    candidate: OwnerVaultSession,
    presentedResumeToken: string | undefined,
    nextResumeToken: string,
    nowMilliseconds: number,
  ) => Effect.Effect<OwnerVaultSession, OwnerVaultSyncError>;
  readonly transactFrame: (
    session: OwnerVaultSession,
    frame: SyncChangeFrame,
    requestHash: string,
    nowMilliseconds: number,
    maximumFramesPerMinute: number,
    apply: Effect.Effect<
      Extract<ServerWebSocketFrame, { readonly type: "syncAcknowledged" }>,
      OwnerVaultSyncError
    >,
  ) => Effect.Effect<
    {
      readonly session: OwnerVaultSession;
      readonly response: Extract<ServerWebSocketFrame, { readonly type: "syncAcknowledged" }>;
    },
    OwnerVaultSyncError
  >;
}

export const OwnerVaultDurableSyncRepository = Context.GenericTag<OwnerVaultDurableSyncRepository>(
  "@enchiridion/worker-vault/v2/sync/OwnerVaultDurableSyncRepository",
);

export interface OwnerVaultSyncLimits {
  readonly maximumFrameBytes: number;
  readonly maximumAttachmentBytes: number;
  readonly maximumSessions: number;
  readonly maximumFramesPerMinute: number;
}

/** Explicit seam P03-06 must implement using validated key material and one DO transaction. */
export interface OwnerVaultSyncDependencies {
  readonly capabilities: OwnerVaultCapabilityVerifier;
  readonly jti: OwnerVaultJtiLedger;
  readonly devices: OwnerVaultDeviceAuthorizer;
  readonly mutations: OwnerVaultMutationStore;
  readonly atomicChanges: OwnerVaultAtomicChange;
  readonly sessionNonce: OwnerVaultSessionNonce;
  readonly resumeTokens: OwnerVaultResumeTokenIssuer;
  readonly limits: OwnerVaultSyncLimits;
}

export const OwnerVaultSyncDependencies = Context.GenericTag<OwnerVaultSyncDependencies>(
  "@enchiridion/worker-vault/v2/sync/OwnerVaultSyncDependencies",
);

export const ownerVaultSyncFailure = <A>(
  reason: OwnerVaultSyncError["reason"],
): Effect.Effect<A, OwnerVaultSyncError> => Effect.fail(new OwnerVaultSyncError({ reason }));
