import { describe, expect, test } from "bun:test";
import {
  type DeviceChallengeProof,
  type DeviceChallengeRequest,
  type SignedDeviceRequestEnvelope,
  deviceRevokeCommandSHA256,
  protocolVersion,
} from "@enchiridion/protocol";
import { P256Crypto as RuntimeP256Crypto, makeP256Crypto } from "@enchiridion/runtime";
import { Effect, Exit, Layer } from "effect";
import { p256DerBase64ToP1363 } from "./p256";
import { makeInMemoryDeviceRegistryRepository } from "./repository";
import { makeDeviceService } from "./service";
import {
  DeviceServiceError,
  ExistingDeviceRecoveryRebinder,
  type OwnerVaultBinding,
} from "./types";

const now = 1_760_000_000_000;
const signatureDER =
  "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=";
const signatureP1363 =
  "CG5y3idBVD4QzwT9I7bvr5KGycsfojCW5hCZsWK3L07i27LLUKURSjw9jQG8DE9iMd0Xc3k/V39q7uBiNzpy1g==";
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

const derInteger = (source: Uint8Array): Uint8Array => {
  let first = 0;
  while (first < source.length - 1 && source[first] === 0) first += 1;
  const value = source.slice(first);
  const prefix = (value[0] ?? 0) & 0x80 ? 1 : 0;
  const output = new Uint8Array(2 + prefix + value.length);
  output[0] = 0x02;
  output[1] = prefix + value.length;
  output.set(value, 2 + prefix);
  return output;
};

const p1363ToDER = (signature: Uint8Array): Uint8Array => {
  const r = derInteger(signature.slice(0, 32));
  const s = derInteger(signature.slice(32));
  const output = new Uint8Array(2 + r.length + s.length);
  output[0] = 0x30;
  output[1] = r.length + s.length;
  output.set(r, 2);
  output.set(s, 2 + r.length);
  return output;
};

describe("v2 device service", () => {
  test("converts the shared TS/Swift P-256 DER vector to 64-byte P1363", () => {
    const bytes = p256DerBase64ToP1363(signatureDER);
    expect(bytes).toBeDefined();
    expect(btoa(String.fromCharCode(...(bytes ?? [])))).toBe(signatureP1363);
    expect(
      p256DerBase64ToP1363(
        "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=",
      ),
    ).toBeDefined();
    expect(p256DerBase64ToP1363("MAYCAQECAQEA")).toBeUndefined();
  });

  test("Workerd-compatible WebCrypto P-256 spike verifies DER converted to P1363", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const payload = new TextEncoder().encode("enchiridion-device-p256-spike");
    const p1363 = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, payload),
    );
    expect(p1363.length).toBe(64);
    const converted = p256DerBase64ToP1363(btoa(String.fromCharCode(...p1363ToDER(p1363))));
    expect(converted).toEqual(p1363);
    const verificationSignature = new Uint8Array(converted?.length ?? 0);
    if (converted !== undefined) verificationSignature.set(converted);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        verificationSignature,
        payload,
      ),
    ).toBe(true);
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
});
