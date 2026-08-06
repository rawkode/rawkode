/** @enchiridion/effect-module */
import type {
  DeviceChallengeProof,
  DeviceChallengeRequest,
  DeviceChallengeResponse,
  DeviceRegisterRequest,
  DeviceRegisterResponse,
  DeviceRevokeCommand,
  DeviceRevokeResponse,
  SignedDeviceRequestEnvelope,
} from "@enchiridion/protocol";
import { Context, Data, type Effect } from "effect";

export interface OwnerVaultBinding {
  readonly ownerID: string;
  readonly vaultID: string;
  readonly generationEpoch: number;
}

export interface DeviceRecord extends OwnerVaultBinding {
  readonly deviceID: string;
  readonly publicKeySPKI: string;
  readonly authEpoch: number;
  readonly credentialEpoch: number;
  readonly revoked: boolean;
  readonly securityFloor: number;
}

export interface DeviceChallengeRecord extends OwnerVaultBinding {
  readonly challengeID: string;
  readonly challengeBase64: string;
  readonly challengeAudience: string;
  readonly devicePublicKey: string;
  readonly expiresAt: number;
  readonly consumed: boolean;
}

export interface DeviceRegistrationResult {
  readonly device: DeviceRecord;
  readonly replayed: boolean;
}

export class DeviceServiceError extends Data.TaggedError("DeviceServiceError")<{
  readonly reason:
    | "challenge_expired"
    | "challenge_not_found"
    | "challenge_consumed"
    | "challenge_mismatch"
    | "challenge_quota"
    | "device_not_found"
    | "device_revoked"
    | "idempotency_conflict"
    | "invalid_proof"
    | "invalid_request"
    | "nonce_replay"
    | "recovery_not_configured"
    | "signature_invalid"
    | "state_conflict"
    | "temporarily_unavailable";
}> {}

export interface DeviceRegistryRepository {
  readonly issueChallenge: (
    input: DeviceChallengeRecord,
    now: number,
  ) => Effect.Effect<DeviceChallengeRecord, DeviceServiceError>;
  readonly getChallenge: (
    challengeID: string,
    now: number,
  ) => Effect.Effect<DeviceChallengeRecord, DeviceServiceError>;
  readonly registerFromChallenge: (input: {
    readonly challengeID: string;
    readonly idempotencyKey: string;
    readonly device: DeviceRecord;
    readonly now: number;
  }) => Effect.Effect<DeviceRegistrationResult, DeviceServiceError>;
  readonly getDevice: (deviceID: string) => Effect.Effect<DeviceRecord, DeviceServiceError>;
  readonly consumeRequestNonce: (input: {
    readonly binding: OwnerVaultBinding;
    readonly actorDeviceID: string;
    readonly nonce: string;
    readonly expiresAt: number;
    readonly now: number;
  }) => Effect.Effect<void, DeviceServiceError>;
  readonly revokeDevice: (input: {
    readonly binding: OwnerVaultBinding;
    readonly targetDeviceID: string;
    readonly requestID: string;
    readonly now: number;
  }) => Effect.Effect<DeviceRecord, DeviceServiceError>;
}
export const DeviceRegistryRepository = Context.GenericTag<DeviceRegistryRepository>(
  "@enchiridion/worker-vault/v2/devices/DeviceRegistryRepository",
);

/** P03-06 durable-object/recovery owner supplies a proofed rebind implementation later. */
export interface ExistingDeviceRecoveryRebinder {
  readonly rebindExistingDevice: (input: {
    readonly binding: OwnerVaultBinding;
    readonly existingDeviceID: string;
    readonly replacementPublicKeySPKI: string;
    readonly recoveryRequestID: string;
  }) => Effect.Effect<DeviceRecord, DeviceServiceError>;
}
export const ExistingDeviceRecoveryRebinder = Context.GenericTag<ExistingDeviceRecoveryRebinder>(
  "@enchiridion/worker-vault/v2/devices/ExistingDeviceRecoveryRebinder",
);

export interface DeviceService {
  /** The Access boundary authenticates the binding before this bootstrap-only operation is called. */
  readonly createAccessChallenge: (
    binding: OwnerVaultBinding,
    request: DeviceChallengeRequest,
    now: number,
  ) => Effect.Effect<DeviceChallengeResponse, DeviceServiceError>;
  readonly registerInitialOrAdditionalDevice: (
    request: DeviceRegisterRequest,
    now: number,
  ) => Effect.Effect<DeviceRegisterResponse, DeviceServiceError>;
  readonly verifySignedActorRequest: (input: {
    readonly envelope: SignedDeviceRequestEnvelope;
    readonly binding: OwnerVaultBinding;
    readonly method: "POST" | "PUT" | "DELETE";
    readonly canonicalPath: string;
    readonly canonicalQuery: string;
    readonly bodySHA256: string;
    readonly now: number;
  }) => Effect.Effect<DeviceRecord, DeviceServiceError>;
  readonly revokeDevice: (input: {
    readonly envelope: SignedDeviceRequestEnvelope;
    readonly command: DeviceRevokeCommand;
    readonly binding: OwnerVaultBinding;
    readonly now: number;
  }) => Effect.Effect<DeviceRevokeResponse, DeviceServiceError>;
  readonly rebindExistingDevice: ExistingDeviceRecoveryRebinder["rebindExistingDevice"];
}
export const DeviceService = Context.GenericTag<DeviceService>(
  "@enchiridion/worker-vault/v2/devices/DeviceService",
);

export type {
  DeviceChallengeProof,
  DeviceChallengeRequest,
  DeviceChallengeResponse,
  DeviceRegisterRequest,
  DeviceRegisterResponse,
  DeviceRevokeCommand,
  DeviceRevokeResponse,
  SignedDeviceRequestEnvelope,
};
