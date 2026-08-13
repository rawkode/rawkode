/** @enchiridion/effect-module */
import {
  deviceChallengeProofSigningPayload,
  deviceRevokeCommandSHA256,
  protocolVersion,
  sha256Hex,
  signedDeviceRequestSigningPayload,
} from "@enchiridion/protocol";
import {
  P256Crypto as RuntimeP256Crypto,
  type P256Crypto as RuntimeP256CryptoService,
  canonicalP256Spki,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  type DeviceChallengeProof,
  type DeviceChallengeRecord,
  type DeviceChallengeRequest,
  type DeviceChallengeResponse,
  type DeviceRecord,
  type DeviceRegisterRequest,
  type DeviceRegisterResponse,
  DeviceRegistryRepository,
  type DeviceRevokeCommand,
  type DeviceRevokeResponse,
  type DeviceService,
  DeviceServiceError,
  ExistingDeviceRecoveryRebinder,
  type OwnerVaultBinding,
  type SignedDeviceRequestEnvelope,
} from "./types";

export const deviceChallengeTTLMilliseconds = 5 * 60 * 1_000;
const signedRequestMaximumTTLMilliseconds = 5 * 60 * 1_000;
const identifier = /^[A-Za-z0-9._~-]{1,128}$/u;

const validBinding = (binding: OwnerVaultBinding): boolean =>
  identifier.test(binding.ownerID) &&
  identifier.test(binding.vaultID) &&
  Number.isSafeInteger(binding.generationEpoch) &&
  binding.generationEpoch >= 0;

const base64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

const base64url = (bytes: Uint8Array): string =>
  base64(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

const canonicalBase64Bytes = (value: string): Uint8Array | undefined => {
  try {
    const text = atob(value);
    if (btoa(text) !== value) return undefined;
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
};

const validDevicePublicKey = (value: string): boolean => {
  const bytes = canonicalBase64Bytes(value);
  return bytes !== undefined && canonicalP256Spki(bytes) !== undefined;
};

const signedFingerprint = (payload: Uint8Array, signature: string): string => {
  const signatureBytes = new TextEncoder().encode(signature);
  const bytes = new Uint8Array(8 + payload.byteLength + signatureBytes.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.byteLength, false);
  bytes.set(payload, 4);
  view.setUint32(4 + payload.byteLength, signatureBytes.byteLength, false);
  bytes.set(signatureBytes, 8 + payload.byteLength);
  return sha256Hex(bytes);
};

export const deviceRegistrationProofFingerprint = (proof: DeviceChallengeProof): string =>
  signedFingerprint(deviceChallengeProofSigningPayload(proof), proof.signature);

const signedRequestFingerprint = (envelope: SignedDeviceRequestEnvelope): string =>
  signedFingerprint(signedDeviceRequestSigningPayload(envelope), envelope.deviceSignature);

const random32 = (
  crypto: RuntimeP256CryptoService,
): Effect.Effect<Uint8Array, DeviceServiceError> =>
  crypto.random32().pipe(
    Effect.mapError(() => new DeviceServiceError({ reason: "temporarily_unavailable" })),
    Effect.flatMap((bytes) =>
      bytes.byteLength === 32
        ? Effect.succeed(bytes)
        : Effect.fail(new DeviceServiceError({ reason: "temporarily_unavailable" })),
    ),
  );

const randomIdentifier = (
  crypto: RuntimeP256CryptoService,
  size: number,
): Effect.Effect<string, DeviceServiceError> =>
  Effect.flatMap(random32(crypto), (bytes) =>
    size > 0 && size <= bytes.byteLength
      ? Effect.succeed(base64url(bytes.slice(0, size)))
      : Effect.fail(new DeviceServiceError({ reason: "temporarily_unavailable" })),
  );

const verifySignature = (
  crypto: RuntimeP256CryptoService,
  publicKeySPKI: string,
  signingPayload: Uint8Array,
  derSignature: string,
): Effect.Effect<void, DeviceServiceError> => {
  const spkiDER = canonicalBase64Bytes(publicKeySPKI);
  const signatureDER = canonicalBase64Bytes(derSignature);
  if (spkiDER === undefined || signatureDER === undefined)
    return Effect.fail(new DeviceServiceError({ reason: "signature_invalid" }));
  return crypto.verify({ spkiDER, message: signingPayload, signatureDER }).pipe(
    Effect.mapError(
      (error) =>
        new DeviceServiceError({
          reason:
            error.reason === "crypto_unavailable" ? "temporarily_unavailable" : "signature_invalid",
        }),
    ),
  );
};

const challengeMatchesProof = (
  challenge: {
    readonly challengeID: string;
    readonly challengeBase64: string;
    readonly challengeAudience: string;
    readonly devicePublicKey: string;
    readonly expiresAt: number;
  },
  proof: DeviceChallengeProof,
): boolean =>
  proof.protocolVersion === protocolVersion &&
  proof.challengeID === challenge.challengeID &&
  proof.challengeBase64 === challenge.challengeBase64 &&
  proof.challengeAudience === challenge.challengeAudience &&
  proof.devicePublicKey === challenge.devicePublicKey &&
  proof.expiresAt === challenge.expiresAt;

const bindingMatchesEnvelope = (
  envelope: SignedDeviceRequestEnvelope,
  binding: OwnerVaultBinding,
): boolean =>
  envelope.protocolVersion === protocolVersion &&
  envelope.ownerID === binding.ownerID &&
  envelope.vaultID === binding.vaultID &&
  envelope.generationEpoch === binding.generationEpoch;

/**
 * Performs the P02 validation and entropy work without touching durable
 * state.  Endpoint composition can therefore prepare a full record before
 * entering its one native receipt/challenge transaction.
 */
export const prepareDeviceAccessChallenge = (
  crypto: RuntimeP256CryptoService,
  binding: OwnerVaultBinding,
  request: DeviceChallengeRequest,
  now: number,
): Effect.Effect<DeviceChallengeRecord, DeviceServiceError> => {
  const expiresAt = now + deviceChallengeTTLMilliseconds;
  if (
    !validBinding(binding) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(expiresAt) ||
    !validDevicePublicKey(request.devicePublicKey)
  )
    return Effect.fail(new DeviceServiceError({ reason: "invalid_request" }));
  return Effect.gen(function* () {
    const challengeID = yield* randomIdentifier(crypto, 16);
    const challengeBytes = yield* random32(crypto);
    return Object.freeze({
      ...binding,
      challengeID,
      challengeBase64: base64(challengeBytes),
      challengeAudience: request.challengeAudience,
      devicePublicKey: request.devicePublicKey,
      expiresAt,
      consumed: false,
    });
  });
};

/**
 * Performs all registration work that is safe before the final durable
 * transaction.  In particular this verifies the proof and draws the device
 * identifier, but never reads or consumes an idempotency receipt and never
 * changes a challenge.  The OwnerVault transaction rechecks those durable
 * facts immediately before committing the registration and capability
 * receipt together.
 */
export const prepareDeviceRegistration = (
  crypto: RuntimeP256CryptoService,
  binding: OwnerVaultBinding,
  challenge: DeviceChallengeRecord,
  request: DeviceRegisterRequest,
): Effect.Effect<DeviceRecord, DeviceServiceError> => {
  if (
    !validBinding(binding) ||
    challenge.ownerID !== binding.ownerID ||
    challenge.vaultID !== binding.vaultID ||
    challenge.generationEpoch !== binding.generationEpoch ||
    !challengeMatchesProof(challenge, request.challengeProof)
  )
    return Effect.fail(new DeviceServiceError({ reason: "challenge_mismatch" }));
  return verifySignature(
    crypto,
    challenge.devicePublicKey,
    deviceChallengeProofSigningPayload(request.challengeProof),
    request.challengeProof.signature,
  ).pipe(
    Effect.flatMap(() => randomIdentifier(crypto, 16)),
    Effect.map((deviceID) => ({
      ownerID: challenge.ownerID,
      vaultID: challenge.vaultID,
      generationEpoch: challenge.generationEpoch,
      deviceID,
      publicKeySPKI: challenge.devicePublicKey,
      authEpoch: 1,
      credentialEpoch: 1,
      revoked: false,
      securityFloor: 0,
    })),
  );
};

export const makeDeviceService = Effect.gen(function* () {
  const crypto = yield* RuntimeP256Crypto;
  const repository = yield* DeviceRegistryRepository;
  const recovery = yield* ExistingDeviceRecoveryRebinder;

  const createAccessChallenge = (
    binding: OwnerVaultBinding,
    request: DeviceChallengeRequest,
    now: number,
  ): Effect.Effect<DeviceChallengeResponse, DeviceServiceError> => {
    return prepareDeviceAccessChallenge(crypto, binding, request, now).pipe(
      Effect.flatMap((prepared) => repository.issueChallenge(prepared, now)),
      Effect.map((challenge) => ({
        protocolVersion,
        challengeID: challenge.challengeID,
        challengeBase64: challenge.challengeBase64,
        expiresAt: challenge.expiresAt,
      })),
    );
  };

  const registerInitialOrAdditionalDevice = (
    request: DeviceRegisterRequest,
    now: number,
  ): Effect.Effect<DeviceRegisterResponse, DeviceServiceError> =>
    Effect.gen(function* () {
      const proofFingerprint = deviceRegistrationProofFingerprint(request.challengeProof);
      const prior = yield* repository.getRegistrationReceipt({
        idempotencyKey: request.idempotencyKey,
        proofFingerprint,
      });
      if (prior !== undefined)
        return {
          protocolVersion,
          ownerID: prior.device.ownerID,
          deviceID: prior.device.deviceID,
          authEpoch: prior.device.authEpoch,
        };
      const challenge = yield* repository.getChallenge(request.challengeProof.challengeID, now);
      if (!challengeMatchesProof(challenge, request.challengeProof))
        return yield* Effect.fail(new DeviceServiceError({ reason: "challenge_mismatch" }));
      yield* verifySignature(
        crypto,
        challenge.devicePublicKey,
        deviceChallengeProofSigningPayload(request.challengeProof),
        request.challengeProof.signature,
      );
      const deviceID = yield* randomIdentifier(crypto, 16);
      const registration = yield* repository.registerFromChallenge({
        challengeID: challenge.challengeID,
        idempotencyKey: request.idempotencyKey,
        proofFingerprint,
        now,
        device: {
          ownerID: challenge.ownerID,
          vaultID: challenge.vaultID,
          generationEpoch: challenge.generationEpoch,
          deviceID,
          publicKeySPKI: challenge.devicePublicKey,
          authEpoch: 1,
          credentialEpoch: 1,
          revoked: false,
          securityFloor: 0,
        },
      });
      return {
        protocolVersion,
        ownerID: registration.device.ownerID,
        deviceID: registration.device.deviceID,
        authEpoch: registration.device.authEpoch,
      };
    });

  const verifySignedActorRequest = (input: {
    readonly envelope: SignedDeviceRequestEnvelope;
    readonly binding: OwnerVaultBinding;
    readonly method: "POST" | "PUT" | "DELETE";
    readonly canonicalPath: string;
    readonly canonicalQuery: string;
    readonly bodySHA256: string;
    readonly now: number;
  }): Effect.Effect<DeviceRecord, DeviceServiceError> => {
    const { envelope, binding, now } = input;
    if (
      !validBinding(binding) ||
      !Number.isSafeInteger(now) ||
      !bindingMatchesEnvelope(envelope, binding) ||
      envelope.method !== input.method ||
      envelope.canonicalPath !== input.canonicalPath ||
      envelope.canonicalQuery !== input.canonicalQuery ||
      envelope.bodySHA256 !== input.bodySHA256 ||
      envelope.issuedAt > now ||
      envelope.expiresAt <= now ||
      envelope.expiresAt - envelope.issuedAt > signedRequestMaximumTTLMilliseconds
    )
      return Effect.fail(new DeviceServiceError({ reason: "invalid_request" }));
    return Effect.gen(function* () {
      const actor = yield* repository.getDevice(envelope.actorDeviceID);
      if (!sameDeviceBinding(actor, binding))
        return yield* Effect.fail(new DeviceServiceError({ reason: "invalid_request" }));
      if (actor.revoked)
        return yield* Effect.fail(new DeviceServiceError({ reason: "device_revoked" }));
      if (
        actor.authEpoch !== envelope.authEpoch ||
        actor.credentialEpoch !== envelope.credentialEpoch ||
        envelope.authEpoch < actor.securityFloor
      )
        return yield* Effect.fail(new DeviceServiceError({ reason: "invalid_request" }));
      yield* verifySignature(
        crypto,
        actor.publicKeySPKI,
        signedDeviceRequestSigningPayload(envelope),
        envelope.deviceSignature,
      );
      return yield* repository.authorizeAndClaimNonce({
        expectedBinding: binding,
        expectedCredentialEpoch: actor.credentialEpoch,
        expectedGenerationEpoch: actor.generationEpoch,
        expectedDeviceID: actor.deviceID,
        expectedAuthEpoch: actor.authEpoch,
        expectedSecurityFloor: actor.securityFloor,
        nonce: envelope.nonce,
        expiresAt: envelope.expiresAt,
        now,
        requestFingerprint: signedRequestFingerprint(envelope),
      });
    });
  };

  const revokeDevice = (input: {
    readonly envelope: SignedDeviceRequestEnvelope;
    readonly command: DeviceRevokeCommand;
    readonly binding: OwnerVaultBinding;
    readonly now: number;
  }): Effect.Effect<DeviceRevokeResponse, DeviceServiceError> => {
    const path = `/v2/devices/${input.command.targetDeviceID}/revoke`;
    if (
      input.envelope.actorDeviceID !== input.command.actorDeviceID ||
      input.envelope.targetDeviceID !== input.command.targetDeviceID
    )
      return Effect.fail(new DeviceServiceError({ reason: "invalid_request" }));
    return Effect.flatMap(
      verifySignedActorRequest({
        envelope: input.envelope,
        binding: input.binding,
        method: "POST",
        canonicalPath: path,
        canonicalQuery: "",
        bodySHA256: deviceRevokeCommandSHA256(input.command),
        now: input.now,
      }),
      () =>
        Effect.map(
          repository.revokeDevice({
            binding: input.binding,
            targetDeviceID: input.command.targetDeviceID,
            requestID: input.envelope.requestID,
            now: input.now,
          }),
          (device) => ({
            protocolVersion,
            ownerID: device.ownerID,
            deviceID: device.deviceID,
            authEpoch: device.authEpoch,
            revokedAt: input.now,
          }),
        ),
    );
  };

  return {
    createAccessChallenge,
    registerInitialOrAdditionalDevice,
    verifySignedActorRequest,
    revokeDevice,
    rebindExistingDevice: recovery.rebindExistingDevice,
  } satisfies DeviceService;
});

const sameDeviceBinding = (device: DeviceRecord, binding: OwnerVaultBinding): boolean =>
  device.ownerID === binding.ownerID &&
  device.vaultID === binding.vaultID &&
  device.generationEpoch === binding.generationEpoch;
