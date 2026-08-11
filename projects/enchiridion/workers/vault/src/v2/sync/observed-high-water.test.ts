import { describe, expect, test } from "bun:test";
import {
  decodeClientWebSocketFrame,
  protocolVersion,
  syncFrameSigningPayloadVersion,
} from "@enchiridion/protocol";
import { Effect, Exit } from "effect";
import { validateObservedHighWater } from "./types";

const frame = () => {
  const decoded = decodeClientWebSocketFrame({
    type: "syncChange",
    protocolVersion,
    vaultID: "vault-1",
    deviceID: "device-1",
    authEpoch: 3,
    credentialEpoch: 4,
    generationEpoch: 5,
    sessionNonce: "AAAAAAAAAAAAAAAAAAAAAA",
    assertionExpiresAt: 1_760_000_120_000,
    operationID: "operation-1",
    sourceKind: "websocket",
    payloadSHA256: "a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222",
    causalVersion: 9,
    observedHighWater: 17,
    frameID: "AAAAAAAAAAAAAAAAAAAAAQ",
    signingPayloadVersion: syncFrameSigningPayloadVersion,
    payloadBase64: "AQI=",
    deviceSignature: "MAYCAQECAQE=",
  });
  if (decoded.type !== "syncChange") throw new Error("Expected sync change");
  return decoded;
};

describe("observed high-water boundary", () => {
  test("rejects a signed client frontier beyond the transactionally reloaded log head", async () => {
    await expect(
      Effect.runPromise(validateObservedHighWater(frame(), 17)),
    ).resolves.toBeUndefined();
    const ahead = await Effect.runPromiseExit(validateObservedHighWater(frame(), 16));
    expect(Exit.isFailure(ahead)).toBe(true);
    expect(JSON.stringify(ahead)).toContain("observed_high_water_ahead");
  });
});
