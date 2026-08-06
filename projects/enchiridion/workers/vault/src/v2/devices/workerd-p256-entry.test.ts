// TEST-ONLY Workerd entry. It is intentionally outside the deployable Effect
// marker boundary: Worker `fetch` is the one native Promise adapter required
// by Wrangler. The service itself remains entirely Effect-based.
import { protocolVersion } from "@enchiridion/protocol";
import { P256Crypto, makeP256Crypto } from "@enchiridion/runtime";
import { Effect, Layer } from "effect";
import { makeInMemoryDeviceRegistryRepository } from "./repository";
import { makeDeviceService } from "./service";
import { DeviceServiceError, ExistingDeviceRecoveryRebinder } from "./types";

const now = 1_760_000_000_000;
const binding = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 };
const challengeProof = {
  protocolVersion,
  challengeID: "AAAAAAAAAAAAAAAAAAAAAA",
  challengeAudience: "enchiridion",
  challengeBase64: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  expiresAt: now + 300_000,
  nonce: "AgICAgICAgICAgICAgICAg",
  devicePublicKey:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHCsce9fUxf7ouqSfL3L9dc68YQVeV0MLyBKMKJiP7Q5G6SUkKPKkycHk4mO+oardm2UrpWVCawvQfbOwM3klBg==",
  signature:
    "MEUCIQCywtmh9SSgZUwin2KjSS40eSxyvXWbwDXARzD/MM483wIgGj0V0T2pF+1cMoltISCg3ZVK5pAzszFrkrbhqaaONTc=",
} as const;
// The mathematically valid high-S twin of challengeProof.signature. The
// runtime canonical parser must reject it before WebCrypto verification.
const committedHighSSignatureDERBase64 =
  "MEYCIQCywtmh9SSgZUwin2KjSS40eSxyvXWbwDXARzD/MM483wIhAOXC6i3CVugTo812kt7fXyInnBQdc2RtGWEC6RlV1PAa";

const unavailableRecovery = {
  rebindExistingDevice: () =>
    Effect.fail(new DeviceServiceError({ reason: "recovery_not_configured" })),
};

const registerFixedProof = (signature: string, idempotencyKey: string) =>
  Effect.gen(function* () {
    const repository = yield* makeInMemoryDeviceRegistryRepository;
    const service = yield* makeDeviceService.pipe(
      Effect.provide(
        Layer.mergeAll(
          repository.layer,
          Layer.succeed(P256Crypto, makeP256Crypto()),
          Layer.succeed(ExistingDeviceRecoveryRebinder, unavailableRecovery),
        ),
      ),
    );
    yield* repository.repository.issueChallenge(
      {
        ...binding,
        challengeID: challengeProof.challengeID,
        challengeBase64: challengeProof.challengeBase64,
        challengeAudience: challengeProof.challengeAudience,
        devicePublicKey: challengeProof.devicePublicKey,
        expiresAt: challengeProof.expiresAt,
        consumed: false,
      },
      now,
    );
    return yield* service.registerInitialOrAdditionalDevice(
      {
        challengeProof: {
          ...challengeProof,
          signature,
        },
        idempotencyKey,
      },
      now,
    );
  });

export default {
  async fetch(request: Request): Promise<Response> {
    const highS = new URL(request.url).pathname === "/high-s";
    const result = await Effect.runPromiseExit(
      registerFixedProof(
        highS ? committedHighSSignatureDERBase64 : challengeProof.signature,
        highS ? "workerd-p256-high-s" : "workerd-p256-fixed",
      ),
    );
    if (result._tag === "Success")
      return Response.json({ ok: true, deviceID: result.value.deviceID });
    return Response.json({ ok: false, reason: result.cause._tag }, { status: 401 });
  },
};
