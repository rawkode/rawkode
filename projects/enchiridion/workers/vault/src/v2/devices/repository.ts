/** @enchiridion/effect-module */
import { Effect, Layer, Ref } from "effect";
import {
  type DeviceChallengeRecord,
  type DeviceNonceAuthorization,
  type DeviceRecord,
  type DeviceRegistrationResult,
  DeviceRegistryRepository,
  DeviceServiceError,
  type OwnerVaultBinding,
} from "./types";

interface RegistrationEntry {
  readonly proofFingerprint: string;
  /** Immutable success receipt; never reload mutable current-device state for a retry. */
  readonly result: DeviceRegistrationResult;
}

interface NonceEntry {
  readonly expiresAt: number;
  readonly requestFingerprint: string;
}

interface RegistryState {
  readonly challenges: Readonly<Record<string, DeviceChallengeRecord>>;
  readonly devices: Readonly<Record<string, DeviceRecord>>;
  readonly registrations: Readonly<Record<string, RegistrationEntry>>;
  readonly nonces: Readonly<Record<string, NonceEntry>>;
  readonly securityFloors: Readonly<Record<string, number>>;
  readonly revokeRequests: Readonly<Record<string, string>>;
}

const challengeQuota = 8;
const bindingKey = (binding: OwnerVaultBinding): string =>
  `${binding.ownerID}\u0000${binding.vaultID}\u0000${binding.generationEpoch}`;
const registrationKey = (idempotencyKey: string): string => idempotencyKey;

const sameBinding = (left: OwnerVaultBinding, right: OwnerVaultBinding): boolean =>
  left.ownerID === right.ownerID &&
  left.vaultID === right.vaultID &&
  left.generationEpoch === right.generationEpoch;

const sameAuthorization = (device: DeviceRecord, input: DeviceNonceAuthorization): boolean =>
  sameBinding(device, input.expectedBinding) &&
  device.generationEpoch === input.expectedGenerationEpoch &&
  device.deviceID === input.expectedDeviceID &&
  device.credentialEpoch === input.expectedCredentialEpoch &&
  device.authEpoch === input.expectedAuthEpoch &&
  device.securityFloor === input.expectedSecurityFloor;

const initialState: RegistryState = {
  challenges: {},
  devices: {},
  registrations: {},
  nonces: {},
  securityFloors: {},
  revokeRequests: {},
};

const succeed = <A>(value: A): Effect.Effect<A, DeviceServiceError> => Effect.succeed(value);
const fail = <A = never>(
  reason: DeviceServiceError["reason"],
): Effect.Effect<A, DeviceServiceError> => Effect.fail(new DeviceServiceError({ reason }));

/**
 * Effect/Ref reference repository. P03-06 replaces this with durable-object persistence while
 * preserving the atomic challenge consumption and revoke operations below.
 */
export const makeInMemoryDeviceRegistryRepository = Effect.gen(function* () {
  const state = yield* Ref.make<RegistryState>(initialState);
  const repository: DeviceRegistryRepository = {
    issueChallenge: (challenge, now) =>
      Ref.modify(state, (current) => {
        const outstanding = Object.values(current.challenges).filter(
          (entry) => sameBinding(entry, challenge) && !entry.consumed && entry.expiresAt > now,
        ).length;
        if (outstanding >= challengeQuota) return [fail("challenge_quota"), current] as const;
        if (current.challenges[challenge.challengeID] !== undefined)
          return [fail("state_conflict"), current] as const;
        return [
          succeed(challenge),
          { ...current, challenges: { ...current.challenges, [challenge.challengeID]: challenge } },
        ] as const;
      }).pipe(Effect.flatten),
    getChallenge: (challengeID, now) =>
      Effect.flatMap(Ref.get(state), (current) => {
        const challenge = current.challenges[challengeID];
        if (challenge === undefined) return fail("challenge_not_found");
        if (challenge.expiresAt <= now) return fail("challenge_expired");
        return succeed(challenge);
      }),
    registerFromChallenge: (input) =>
      Ref.modify(state, (current) => {
        const key = registrationKey(input.idempotencyKey);
        const prior = current.registrations[key];
        if (prior !== undefined) {
          return prior.proofFingerprint === input.proofFingerprint
            ? ([succeed({ ...prior.result, replayed: true }), current] as const)
            : ([fail("idempotency_conflict"), current] as const);
        }
        const challenge = current.challenges[input.challengeID];
        if (challenge === undefined) return [fail("challenge_not_found"), current] as const;
        if (challenge.expiresAt <= input.now) return [fail("challenge_expired"), current] as const;
        if (challenge.consumed) return [fail("challenge_consumed"), current] as const;
        if (
          !sameBinding(challenge, input.device) ||
          challenge.devicePublicKey !== input.device.publicKeySPKI
        )
          return [fail("challenge_mismatch"), current] as const;
        if (current.devices[input.device.deviceID] !== undefined)
          return [fail("state_conflict"), current] as const;
        const consumed = { ...challenge, consumed: true };
        const result: DeviceRegistrationResult = { device: input.device, replayed: false };
        return [
          succeed(result),
          {
            ...current,
            challenges: { ...current.challenges, [challenge.challengeID]: consumed },
            devices: { ...current.devices, [input.device.deviceID]: input.device },
            registrations: {
              ...current.registrations,
              [key]: { proofFingerprint: input.proofFingerprint, result },
            },
          },
        ] as const;
      }).pipe(Effect.flatten),
    getRegistrationReceipt: (input) =>
      Effect.flatMap(Ref.get(state), (current) => {
        const prior = current.registrations[registrationKey(input.idempotencyKey)];
        if (prior === undefined) return succeed(undefined);
        return prior.proofFingerprint === input.proofFingerprint
          ? succeed({ ...prior.result, replayed: true })
          : fail("idempotency_conflict");
      }),
    getDevice: (deviceID) =>
      Effect.flatMap(Ref.get(state), (current) => {
        const device = current.devices[deviceID];
        return device === undefined ? fail("device_not_found") : succeed(device);
      }),
    authorizeAndClaimNonce: (input) =>
      Ref.modify(state, (current) => {
        const device = current.devices[input.expectedDeviceID];
        if (device === undefined) return [fail("device_not_found"), current] as const;
        if (device.revoked) return [fail("device_revoked"), current] as const;
        if (!sameAuthorization(device, input)) return [fail("state_conflict"), current] as const;
        const key = `${bindingKey(input.expectedBinding)}\u0000${device.deviceID}\u0000${input.nonce}`;
        const prior = current.nonces[key];
        if (prior !== undefined && prior.expiresAt > input.now)
          return [fail("nonce_replay"), current] as const;
        return [
          succeed(device),
          {
            ...current,
            nonces: {
              ...current.nonces,
              [key]: { expiresAt: input.expiresAt, requestFingerprint: input.requestFingerprint },
            },
          },
        ] as const;
      }).pipe(Effect.flatten),
    revokeDevice: (input) =>
      Ref.modify(state, (current) => {
        const idempotencyKey = `${bindingKey(input.binding)}\u0000${input.targetDeviceID}\u0000${input.requestID}`;
        const replay = current.revokeRequests[idempotencyKey];
        if (replay !== undefined) {
          const device = current.devices[replay];
          return device === undefined
            ? ([fail("state_conflict"), current] as const)
            : ([succeed(device), current] as const);
        }
        const target = current.devices[input.targetDeviceID];
        if (target === undefined) return [fail("device_not_found"), current] as const;
        if (!sameBinding(target, input.binding))
          return [fail("challenge_mismatch"), current] as const;
        const floorKey = bindingKey(input.binding);
        const nextFloor = (current.securityFloors[floorKey] ?? 0) + 1;
        const revoked = target.revoked
          ? target
          : { ...target, revoked: true, authEpoch: target.authEpoch + 1, securityFloor: nextFloor };
        return [
          succeed(revoked),
          {
            ...current,
            devices: { ...current.devices, [revoked.deviceID]: revoked },
            securityFloors: { ...current.securityFloors, [floorKey]: nextFloor },
            revokeRequests: { ...current.revokeRequests, [idempotencyKey]: revoked.deviceID },
          },
        ] as const;
      }).pipe(Effect.flatten),
  };
  return { repository, state, layer: Layer.succeed(DeviceRegistryRepository, repository) };
});
