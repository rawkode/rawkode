import { describe, expect, test } from "bun:test";
import {
  type DeviceChallengeProof,
  type DeviceChallengeRequest,
  type SignedDeviceRequestEnvelope,
  deviceRevokeCommandSHA256,
  protocolVersion,
} from "@enchiridion/protocol";
import {
  P256VerificationError,
  P256Crypto as RuntimeP256Crypto,
  makeP256Crypto,
  p256DerSignatureToP1363,
} from "@enchiridion/runtime";
import { Deferred, Effect, Exit, Layer } from "effect";
import { makeInMemoryDeviceRegistryRepository } from "./repository";
import { makeDeviceService, prepareDeviceAccessChallenge } from "./service";
import {
  DeviceServiceError,
  ExistingDeviceRecoveryRebinder,
  type OwnerVaultBinding,
} from "./types";

const now = 1_760_000_000_000;
const signatureDER =
  "MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==";
const signatureP1363 =
  "CG5y3idBVD4QzwT9I7bvr5KGycsfojCW5hCZsWK3L04dJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==";
const highSSignatureDER =
  "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=";
const spki =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeRo6IA5qHb0Clfwa7yCD4u0UOVCKLCcaGkWz1/94iIrBm/IjXooNCCb3LCnkD8iM899EHZ3CswgZ3zSXHHERUA==";
const binding: OwnerVaultBinding = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 };
const frameIDs = [
  "AAAAAAAAAAAAAAAAAAAAAA",
  "AQEBAQEBAQEBAQEBAQEBAQ",
  "AgICAgICAgICAgICAgICAg",
  "AwMDAwMDAwMDAwMDAwMDAw",
] as const;

const challengeRequest: DeviceChallengeRequest = {
  protocolVersion,
  devicePublicKey: spki,
  challengeAudience: "enchiridion",
};

const fixedChallengeProof: DeviceChallengeProof = {
  protocolVersion,
  challengeID: "AAAAAAAAAAAAAAAAAAAAAA",
  challengeAudience: "enchiridion",
  challengeBase64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  expiresAt: now + 300_000,
  nonce: frameIDs[2],
  devicePublicKey:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHCsce9fUxf7ouqSfL3L9dc68YQVeV0MLyBKMKJiP7Q5G6SUkKPKkycHk4mO+oardm2UrpWVCawvQfbOwM3klBg==",
  signature:
    "MEUCIQCywtmh9SSgZUwin2KjSS40eSxyvXWbwDXARzD/MM483wIgGj0V0T2pF+1cMoltISCg3ZVK5pAzszFrkrbhqaaONTc=",
};

const testP256Crypto = () => {
  let value = 1;
  return {
    random32: () => {
      const output = new Uint8Array(32);
      output.fill(value);
      value += 1;
      return Effect.succeed(output);
    },
    verify: () => Effect.void,
  };
};

const unavailableRecovery = {
  rebindExistingDevice: () =>
    Effect.fail(new DeviceServiceError({ reason: "recovery_not_configured" })),
};

const service = async () => {
  const repository = await Effect.runPromise(makeInMemoryDeviceRegistryRepository);
  const deviceService = await Effect.runPromise(
    makeDeviceService.pipe(
      Effect.provide(
        Layer.mergeAll(
          repository.layer,
          Layer.succeed(RuntimeP256Crypto, testP256Crypto()),
          Layer.succeed(ExistingDeviceRecoveryRebinder, unavailableRecovery),
        ),
      ),
    ),
  );
  return { repository, deviceService };
};

const serviceWithRuntimeP256 = async () => {
  const repository = await Effect.runPromise(makeInMemoryDeviceRegistryRepository);
  const deviceService = await Effect.runPromise(
    makeDeviceService.pipe(
      Effect.provide(
        Layer.mergeAll(
          repository.layer,
          Layer.succeed(RuntimeP256Crypto, makeP256Crypto()),
          Layer.succeed(ExistingDeviceRecoveryRebinder, unavailableRecovery),
        ),
      ),
    ),
  );
  return { repository, deviceService };
};

const register = async (
  deviceService: Awaited<ReturnType<typeof service>>["deviceService"],
  idempotencyKey: string,
) => {
  const challenge = await Effect.runPromise(
    deviceService.createAccessChallenge(binding, challengeRequest, now),
  );
  const proof: DeviceChallengeProof = {
    protocolVersion,
    challengeID: challenge.challengeID,
    challengeAudience: challengeRequest.challengeAudience,
    challengeBase64: challenge.challengeBase64,
    expiresAt: challenge.expiresAt,
    nonce: frameIDs[0],
    devicePublicKey: spki,
    signature: signatureDER,
  };
  const response = await Effect.runPromise(
    deviceService.registerInitialOrAdditionalDevice({ challengeProof: proof, idempotencyKey }, now),
  );
  return { challenge, proof, response };
};

const revokeEnvelope = (
  actorDeviceID: string,
  targetDeviceID: string,
  nonce: string,
): SignedDeviceRequestEnvelope => {
  const command = { type: "deviceRevoke" as const, actorDeviceID, targetDeviceID };
  return {
    protocolVersion,
    method: "POST",
    canonicalPath: `/v2/devices/${targetDeviceID}/revoke`,
    canonicalQuery: "",
    bodySHA256: deviceRevokeCommandSHA256(command),
    requestID: "revoke-request-0001",
    idempotencyKey: "revoke-idempotency-1",
    ownerID: binding.ownerID,
    vaultID: binding.vaultID,
    generationEpoch: binding.generationEpoch,
    actorDeviceID,
    targetDeviceID,
    authEpoch: 1,
    credentialEpoch: 1,
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    nonce,
    deviceSignature: signatureDER,
  };
};

const fromBase64 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "base64"));

describe("v2 device service", () => {
  test("prepares no mutable challenge for invalid P-256 input or unavailable entropy", async () => {
    const invalid = await Effect.runPromiseExit(
      prepareDeviceAccessChallenge(
        testP256Crypto(),
        binding,
        { ...challengeRequest, devicePublicKey: "not-p256" },
        now,
      ),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
    expect(JSON.stringify(invalid)).toContain("invalid_request");
    const unavailable = {
      random32: () => Effect.fail(new P256VerificationError({ reason: "crypto_unavailable" })),
      verify: () => Effect.void,
    };
    const failed = await Effect.runPromiseExit(
      prepareDeviceAccessChallenge(unavailable, binding, challengeRequest, now),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(JSON.stringify(failed)).toContain("temporarily_unavailable");
  });

  test("uses the runtime canonical low-S DER parser for the shared TS/Swift vector", () => {
    const bytes = p256DerSignatureToP1363(fromBase64(signatureDER));
    expect(bytes).toBeDefined();
    expect(btoa(String.fromCharCode(...(bytes ?? [])))).toBe(signatureP1363);
    expect(p256DerSignatureToP1363(fromBase64("MAYCAQACAQE="))).toBeUndefined();
    expect(p256DerSignatureToP1363(fromBase64("MAYCAQECAQA="))).toBeUndefined();
    expect(p256DerSignatureToP1363(fromBase64(highSSignatureDER))).toBeUndefined();
  });

  test("wires the fixed challenge proof through the audited runtime P-256 service", async () => {
    const { repository, deviceService } = await serviceWithRuntimeP256();
    await Effect.runPromise(
      repository.repository.issueChallenge(
        {
          ...binding,
          challengeID: fixedChallengeProof.challengeID,
          challengeBase64: fixedChallengeProof.challengeBase64,
          challengeAudience: fixedChallengeProof.challengeAudience,
          devicePublicKey: fixedChallengeProof.devicePublicKey,
          expiresAt: fixedChallengeProof.expiresAt,
          consumed: false,
        },
        now,
      ),
    );
    const registered = await Effect.runPromise(
      deviceService.registerInitialOrAdditionalDevice(
        { challengeProof: fixedChallengeProof, idempotencyKey: "runtime-p256-vector" },
        now,
      ),
    );
    expect(registered.ownerID).toBe(binding.ownerID);

    const second = await serviceWithRuntimeP256();
    await Effect.runPromise(
      second.repository.repository.issueChallenge(
        {
          ...binding,
          challengeID: fixedChallengeProof.challengeID,
          challengeBase64: fixedChallengeProof.challengeBase64,
          challengeAudience: fixedChallengeProof.challengeAudience,
          devicePublicKey: fixedChallengeProof.devicePublicKey,
          expiresAt: fixedChallengeProof.expiresAt,
          consumed: false,
        },
        now,
      ),
    );
    const tampered = await Effect.runPromiseExit(
      second.deviceService.registerInitialOrAdditionalDevice(
        {
          challengeProof: { ...fixedChallengeProof, challengeAudience: "tampered" },
          idempotencyKey: "runtime-p256-tampered",
        },
        now,
      ),
    );
    expect(Exit.isFailure(tampered)).toBe(true);
  });

  test("issues a 256-bit Access-bound challenge and persists one-use idempotent registration", async () => {
    const { deviceService } = await service();
    const result = await register(deviceService, "register-idempotency-1");
    expect(atob(result.challenge.challengeBase64).length).toBe(32);
    expect(result.response.ownerID).toBe(binding.ownerID);
    const replay = await Effect.runPromise(
      deviceService.registerInitialOrAdditionalDevice(
        { challengeProof: result.proof, idempotencyKey: "register-idempotency-1" },
        now,
      ),
    );
    expect(replay.deviceID).toBe(result.response.deviceID);
    const conflict = await Effect.runPromiseExit(
      deviceService.registerInitialOrAdditionalDevice(
        { challengeProof: result.proof, idempotencyKey: "register-idempotency-2" },
        now,
      ),
    );
    expect(Exit.isFailure(conflict)).toBe(true);
  });

  test("returns the immutable registration receipt before expiry checks and conflicts on a changed proof", async () => {
    const { repository, deviceService } = await service();
    const registered = await register(deviceService, "receipt-idempotency");
    const current = await Effect.runPromise(
      repository.repository.revokeDevice({
        binding,
        targetDeviceID: registered.response.deviceID,
        requestID: "receipt-revoke",
        now,
      }),
    );
    expect(current.authEpoch).toBe(2);
    const retry = await Effect.runPromise(
      deviceService.registerInitialOrAdditionalDevice(
        { challengeProof: registered.proof, idempotencyKey: "receipt-idempotency" },
        registered.challenge.expiresAt + 1,
      ),
    );
    expect(retry).toEqual(registered.response);
    const mismatched = await Effect.runPromiseExit(
      deviceService.registerInitialOrAdditionalDevice(
        {
          challengeProof: { ...registered.proof, challengeAudience: "changed-audience" },
          idempotencyKey: "receipt-idempotency",
        },
        registered.challenge.expiresAt + 1,
      ),
    );
    expect(Exit.isFailure(mismatched)).toBe(true);
  });

  test("rejects challenge expiry, quota excess, and concurrent competing registrations", async () => {
    const { deviceService } = await service();
    const expired = await Effect.runPromise(
      deviceService.createAccessChallenge(binding, challengeRequest, now),
    );
    const expiredProof: DeviceChallengeProof = {
      protocolVersion,
      challengeID: expired.challengeID,
      challengeAudience: challengeRequest.challengeAudience,
      challengeBase64: expired.challengeBase64,
      expiresAt: expired.expiresAt,
      nonce: frameIDs[0],
      devicePublicKey: spki,
      signature: signatureDER,
    };
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          deviceService.registerInitialOrAdditionalDevice(
            { challengeProof: expiredProof, idempotencyKey: "expired-idempotency" },
            expired.expiresAt,
          ),
        ),
      ),
    ).toBe(true);
    const { deviceService: quotaService } = await service();
    for (let index = 0; index < 8; index += 1)
      await Effect.runPromise(quotaService.createAccessChallenge(binding, challengeRequest, now));
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          quotaService.createAccessChallenge(binding, challengeRequest, now),
        ),
      ),
    ).toBe(true);

    const { deviceService: concurrentService } = await service();
    const concurrentChallenge = await Effect.runPromise(
      concurrentService.createAccessChallenge(binding, challengeRequest, now),
    );
    const concurrentProof: DeviceChallengeProof = {
      protocolVersion,
      challengeID: concurrentChallenge.challengeID,
      challengeAudience: challengeRequest.challengeAudience,
      challengeBase64: concurrentChallenge.challengeBase64,
      expiresAt: concurrentChallenge.expiresAt,
      nonce: frameIDs[0],
      devicePublicKey: spki,
      signature: signatureDER,
    };
    const concurrent = await Effect.runPromise(
      Effect.all(
        [
          concurrentService
            .registerInitialOrAdditionalDevice(
              { challengeProof: concurrentProof, idempotencyKey: "concurrent-one" },
              now,
            )
            .pipe(Effect.exit),
          concurrentService
            .registerInitialOrAdditionalDevice(
              { challengeProof: concurrentProof, idempotencyKey: "concurrent-two" },
              now,
            )
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(concurrent.filter(Exit.isSuccess)).toHaveLength(1);
    expect(concurrent.filter(Exit.isFailure)).toHaveLength(1);
  });

  test("validates signed actor proof, consumes nonce, and bumps target auth/security epoch on revoke", async () => {
    const { deviceService } = await service();
    const actor = await register(deviceService, "actor-idempotency");
    const target = await register(deviceService, "target-idempotency");
    const envelope = revokeEnvelope(actor.response.deviceID, target.response.deviceID, frameIDs[1]);
    const command = {
      type: "deviceRevoke" as const,
      actorDeviceID: actor.response.deviceID,
      targetDeviceID: target.response.deviceID,
    };
    const revoked = await Effect.runPromise(
      deviceService.revokeDevice({ envelope, command, binding, now }),
    );
    expect(revoked.authEpoch).toBe(2);
    const replay = await Effect.runPromiseExit(
      deviceService.revokeDevice({ envelope, command, binding, now }),
    );
    expect(Exit.isFailure(replay)).toBe(true);
    const retry = await Effect.runPromise(
      deviceService.revokeDevice({
        envelope: { ...envelope, nonce: frameIDs[3] },
        command,
        binding,
        now,
      }),
    );
    expect(retry.authEpoch).toBe(revoked.authEpoch);
    const malformed = await Effect.runPromiseExit(
      deviceService.revokeDevice({
        envelope: { ...envelope, canonicalPath: "/v2/devices/other/revoke", nonce: frameIDs[2] },
        command,
        binding,
        now,
      }),
    );
    expect(Exit.isFailure(malformed)).toBe(true);
  });

  test("requires exact binding, credential, generation, device, auth, and security expectations to claim a nonce", async () => {
    const { repository, deviceService } = await service();
    const actor = await register(deviceService, "authorization-actor");
    const expected = {
      expectedBinding: binding,
      expectedCredentialEpoch: 1,
      expectedGenerationEpoch: binding.generationEpoch,
      expectedDeviceID: actor.response.deviceID,
      expectedAuthEpoch: 1,
      expectedSecurityFloor: 0,
      expiresAt: now + 60_000,
      now,
      requestFingerprint: "a".repeat(64),
    };
    const rejected = await Effect.runPromise(
      Effect.all(
        [
          repository.repository
            .authorizeAndClaimNonce({
              ...expected,
              expectedBinding: { ...binding, vaultID: "other-vault" },
              nonce: frameIDs[0],
            })
            .pipe(Effect.exit),
          repository.repository
            .authorizeAndClaimNonce({
              ...expected,
              expectedCredentialEpoch: 2,
              nonce: frameIDs[1],
            })
            .pipe(Effect.exit),
          repository.repository
            .authorizeAndClaimNonce({
              ...expected,
              expectedGenerationEpoch: 2,
              nonce: frameIDs[2],
            })
            .pipe(Effect.exit),
          repository.repository
            .authorizeAndClaimNonce({
              ...expected,
              expectedDeviceID: "other-device",
              nonce: frameIDs[3],
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(rejected.every(Exit.isFailure)).toBe(true);
    const staleEpoch = await Effect.runPromiseExit(
      repository.repository.authorizeAndClaimNonce({
        ...expected,
        expectedAuthEpoch: 2,
        nonce: "BAQEBAQEBAQEBAQEBAQEBA",
      }),
    );
    expect(Exit.isFailure(staleEpoch)).toBe(true);
    const staleFloor = await Effect.runPromiseExit(
      repository.repository.authorizeAndClaimNonce({
        ...expected,
        expectedSecurityFloor: 1,
        nonce: "BQUFBQUFBQUFBQUFBQUFBQ",
      }),
    );
    expect(Exit.isFailure(staleFloor)).toBe(true);
  });

  test("atomically denies a verified actor request when revocation wins before nonce authorization", async () => {
    const { repository, deviceService } = await service();
    const actor = await register(deviceService, "race-actor");
    const verifyStarted = await Effect.runPromise(Deferred.make<void>());
    const allowVerification = await Effect.runPromise(Deferred.make<void>());
    const pausedP256 = {
      random32: testP256Crypto().random32,
      verify: () =>
        Deferred.succeed(verifyStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(allowVerification)),
        ),
    };
    const pausedService = await Effect.runPromise(
      makeDeviceService.pipe(
        Effect.provide(
          Layer.mergeAll(
            repository.layer,
            Layer.succeed(RuntimeP256Crypto, pausedP256),
            Layer.succeed(ExistingDeviceRecoveryRebinder, unavailableRecovery),
          ),
        ),
      ),
    );
    const envelope = revokeEnvelope(actor.response.deviceID, actor.response.deviceID, frameIDs[3]);
    const pending = Effect.runPromiseExit(
      pausedService.verifySignedActorRequest({
        envelope,
        binding,
        method: "POST",
        canonicalPath: envelope.canonicalPath,
        canonicalQuery: "",
        bodySHA256: envelope.bodySHA256,
        now,
      }),
    );
    await Effect.runPromise(Deferred.await(verifyStarted));
    await Effect.runPromise(
      repository.repository.revokeDevice({
        binding,
        targetDeviceID: actor.response.deviceID,
        requestID: "race-revoke",
        now,
      }),
    );
    await Effect.runPromise(Deferred.succeed(allowVerification, undefined));
    const result = await pending;
    expect(Exit.isFailure(result)).toBe(true);
  });
});
