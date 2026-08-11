/** @enchiridion/effect-module */
import type { SignedCapability } from "@enchiridion/runtime";
import type { Effect } from "effect";
import type { DirectoryIdentity } from "../foundation/schemas";

export const directoryCapabilityPath = "/v2/internal/directory/resolve";
export const directoryOperation = "resolve-or-bootstrap";

export interface DirectoryWireRequest {
  readonly aliases: readonly string[];
  readonly currentAlias: string;
  readonly accessExpiresAt: number;
  readonly operation: typeof directoryOperation;
}

export interface DirectoryInvocation {
  readonly capability: SignedCapability;
  readonly request: DirectoryWireRequest;
}

export interface DirectoryResolution extends DirectoryIdentity {
  /** Deterministic, binding-scoped initializer id. It is never derived from Access claims. */
  readonly initID: string;
  readonly activeGeneration: number;
  readonly routingEpoch: number;
  readonly credentialEpoch: number;
  /** Directory-owned control floor; private targets must inherit it exactly. */
  readonly controlEpoch: number;
}

export interface DirectoryReplay {
  readonly fingerprint: string;
  /** Capability expiry remains the authorization boundary. */
  readonly expiresAt: number;
  /** Replay reservation survives bounded retry/skew after capability expiry. */
  readonly retainUntil: number;
  readonly resolution: DirectoryResolution;
}

export interface DirectoryState {
  readonly aliases: Readonly<Record<string, string>>;
  readonly bindings: Readonly<Record<string, DirectoryResolution>>;
  readonly replays: Readonly<Record<string, DirectoryReplay>>;
  /** Internal DirectoryControl capability receipts, distinct from bootstrap and operation journals. */
  readonly controlReplays: Readonly<Record<string, DirectoryControlReplay>>;
  /** Lifecycle operations are durable evidence, never transient RPC state. */
  readonly transitions: Readonly<Record<string, DirectoryCredentialTransition>>;
  /** A binding remains fenced from PREPARED until its terminal journal result. */
  readonly frozenBindings: Readonly<Record<string, DirectoryFreeze>>;
  /**
   * Permanent, binding-derived aliases which must never select or create an
   * owner again. The evidence deliberately contains no Access identity.
   */
  readonly retiredAliases: Readonly<Record<string, DirectoryRetiredAlias>>;
  /** Every binding has one durable initialization command before it can route. */
  readonly initializations: Readonly<Record<string, DirectoryOwnerVaultInitialization>>;
  /**
   * Private target rows are keyed by a caller-supplied recovery operation. They
   * are deliberately separate from public bindings: no source scope becomes
   * authority over the target.
   */
  readonly privateGenerations: Readonly<Record<string, DirectoryPrivateGeneration>>;
}

export interface DirectoryControlReplay {
  readonly operationID: string;
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly retainUntil: number;
}

/** Directory-owned, random operation evidence for a fresh OwnerVault generation. */
export interface DirectoryOwnerVaultInitialization {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly initDigest: string;
  /** Opaque OwnerVault receipt persisted only after its exact acknowledgement. */
  readonly durableReceipt?: string;
}

export type DirectoryPrivateGenerationPhase = "PRIVATE_INITIALIZING" | "PRIVATE_READY";

/**
 * Directory owns this target-root authority row.  Source scope is never
 * persisted here; the caller may use it only to locate the authoritative root
 * before allocation.
 */
export interface DirectoryPrivateGeneration {
  readonly operationID: string;
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly phase: DirectoryPrivateGenerationPhase;
  readonly initialization: DirectoryOwnerVaultInitialization;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  /** The latest exact, durable forward-only acknowledgement, if floors moved. */
  readonly floorSync?: DirectoryOwnerVaultFloorSync;
}

export interface DirectoryOwnerVaultFloorSync {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
  readonly operationID: string;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly controlEpoch: number;
  readonly floorSyncDigest: string;
  /** Opaque OwnerVault receipt persisted only after exact acknowledgement. */
  readonly durableReceipt?: string;
}

export type DirectoryCredentialTransitionPhase =
  | "PREPARED"
  | "FROZEN"
  | "OWNER_ACKED"
  | "DIRECTORY_CAS"
  | "COMPLETED";

export type DirectoryCredentialTransitionKind = "revoke" | "rebind";

export interface DirectoryTransitionAuthority {
  /** A provider must verify this proof against a registered, non-revoked device. */
  readonly _tag: "registered_device";
  readonly deviceID: string;
  readonly proofID: string;
}

export interface DirectoryOfflineRecoveryAuthority {
  /** Deliberately opaque: email, issuer and subject are not recovery authority. */
  readonly _tag: "offline_recovery";
  readonly recoveryID: string;
}

export type DirectoryTransitionRequest = {
  readonly operationID: string;
  readonly kind: DirectoryCredentialTransitionKind;
  readonly bindingID: string;
  readonly authority: DirectoryTransitionAuthority | DirectoryOfflineRecoveryAuthority;
  readonly expected: DirectoryResolution;
} & (
  | { readonly kind: "revoke" }
  | { readonly kind: "rebind"; readonly replacementAliases: readonly string[] }
);

export interface DirectoryFreeze {
  readonly operationID: string;
  readonly credentialEpochFloor: number;
  readonly routingEpochFloor: number;
}

export interface DirectoryRetiredAlias {
  readonly bindingID: string;
  readonly operationID: string;
  readonly ownerID: string;
  readonly vaultID: string;
  readonly reason: DirectoryCredentialTransitionKind;
  readonly retiredAt: number;
  readonly activeGeneration: number;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
}

export interface DirectoryCredentialTransition {
  readonly operationID: string;
  readonly fingerprint: string;
  readonly kind: DirectoryCredentialTransitionKind;
  readonly bindingID: string;
  readonly expected: DirectoryResolution;
  /** Exact source aliases captured before the binding is frozen. */
  readonly sourceAliases: readonly string[];
  readonly replacementAliases: readonly string[];
  readonly phase: DirectoryCredentialTransitionPhase;
  readonly freeze: DirectoryFreeze;
  /** Immutable owner acknowledgement; every retry must match this exact evidence. */
  readonly ownerAck?: DirectoryOwnerFenceAck;
  /** Terminal result retained for duplicate operation replay. */
  readonly result?: DirectoryCredentialTransitionResult;
  /** Authorization receipt lifecycle; retained evidence never outlives its bounded replay window. */
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly retainUntil: number;
}

export interface DirectoryOwnerFenceRequest {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generation: number;
  readonly operationID: string;
  readonly expectedCredentialEpoch: number;
  readonly expectedRoutingEpoch: number;
}

export interface DirectoryOwnerFenceAck extends DirectoryOwnerFenceRequest {
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly admissionsStopped: true;
  readonly socketsFenced: true;
}

export interface DirectoryCredentialTransitionResult {
  readonly operationID: string;
  readonly kind: DirectoryCredentialTransitionKind;
  readonly bindingID: string;
  readonly credentialEpoch: number;
  readonly routingEpoch: number;
  readonly replacementBindingID?: string;
}

export interface DirectorySecureRandom {
  /** Returns one opaque identifier for a single domain-separated purpose. */
  readonly identifier: (
    purpose: "owner" | "vault" | "owner-vault-initialization" | "owner-vault-floor-sync",
  ) => Effect.Effect<string, DirectoryRandomError>;
}

export interface DirectoryRandomError {
  readonly _tag: "DirectoryRandomError";
}
