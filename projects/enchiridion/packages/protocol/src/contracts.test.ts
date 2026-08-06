import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeClientWebSocketFrame,
  decodeDeviceRegisterRequest,
  decodeErrorEnvelope,
  decodeServerWebSocketFrame,
  protocolVersion,
  syncChangeSigningPayload,
  websocketContract,
} from "./contracts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p256SignatureBase64 = "MAYCAQECAQE=";
const p256SPKIBase64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const validFrameID = "AAAAAAAAAAAAAAAAAAAAAA";

function signedSyncChange(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "syncChange",
    protocolVersion,
    vaultID: "vault-1",
    deviceID: "device-1",
    authEpoch: 3,
    changeID: "change-1",
    causalVersion: 9,
    frameID: validFrameID,
    signingPayloadVersion: 1,
    payloadBase64: "AQI=",
    deviceSignature: p256SignatureBase64,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object golden vector.");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string golden vector.");
  return value;
}

describe("v2 protocol schemas", () => {
  test("accept the golden HTTP registration vector", () => {
    expect(
      decodeDeviceRegisterRequest({
        protocolVersion,
        challengeID: "challenge-1",
        challengeAudience: "enchiridion",
        challengeProof: p256SignatureBase64,
        devicePublicKey: p256SPKIBase64,
        idempotencyKey: "request-1",
      }),
    ).toEqual({
      protocolVersion,
      challengeID: "challenge-1",
      challengeAudience: "enchiridion",
      challengeProof: p256SignatureBase64,
      devicePublicKey: p256SPKIBase64,
      idempotencyKey: "request-1",
    });
  });

  test("reject unknown and invalid public values at the boundary", () => {
    expect(() =>
      decodeDeviceRegisterRequest({
        protocolVersion: 2,
        challengeID: "",
        challengeAudience: "a",
        challengeProof:
          "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        devicePublicKey:
          "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        idempotencyKey: "d",
      }),
    ).toThrow();
    expect(() =>
      decodeDeviceRegisterRequest({
        protocolVersion,
        challengeID: "challenge-1",
        challengeAudience: "enchiridion",
        challengeProof: "MAYCAQECAQEA",
        devicePublicKey: p256SPKIBase64,
        idempotencyKey: "request-1",
      }),
    ).toThrow();
    expect(() =>
      decodeDeviceRegisterRequest({
        protocolVersion,
        challengeID: "challenge-1",
        challengeAudience: "enchiridion",
        challengeProof: p256SignatureBase64,
        devicePublicKey: `${p256SPKIBase64.slice(0, -4)}AQID`,
        idempotencyKey: "request-1",
      }),
    ).toThrow();
    expect(() =>
      decodeErrorEnvelope({
        protocolVersion: 2,
        error: { code: "not-a-code", message: "x", retryable: false },
      }),
    ).toThrow();
  });

  test("keeps HTTP 426 and WebSocket 4426 as compatibility constants", () => {
    expect(websocketContract.httpNegotiationFailureStatus).toBe(426);
    expect(websocketContract.negotiationFailureCloseCode).toBe(4426);
  });

  test("rejects unknown object members for HTTP and WebSocket frames", () => {
    expect(() =>
      decodeDeviceRegisterRequest({
        protocolVersion,
        challengeID: "challenge-1",
        challengeAudience: "enchiridion",
        challengeProof: p256SignatureBase64,
        devicePublicKey: p256SPKIBase64,
        idempotencyKey: "request-1",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      decodeServerWebSocketFrame({
        type: "error",
        protocolVersion,
        error: { code: "invalid_request", message: "x", retryable: false, extra: true },
      }),
    ).toThrow();
  });

  test("accepts only canonical Base64 text and canonical base64url frame IDs", () => {
    expect(decodeClientWebSocketFrame(signedSyncChange({ payloadBase64: "AA==" })).type).toBe(
      "syncChange",
    );
    expect(() => decodeClientWebSocketFrame(signedSyncChange({ payloadBase64: "AB==" }))).toThrow();
    expect(() =>
      decodeDeviceRegisterRequest({
        protocolVersion,
        challengeID: "challenge-1",
        challengeAudience: "enchiridion",
        challengeProof: "MAYCAQECAQF=",
        devicePublicKey: p256SPKIBase64,
        idempotencyKey: "request-1",
      }),
    ).toThrow();
    expect(() =>
      decodeDeviceRegisterRequest({
        protocolVersion,
        challengeID: "challenge-1",
        challengeAudience: "enchiridion",
        challengeProof: p256SignatureBase64,
        devicePublicKey: p256SPKIBase64.replace(/AA==$/, "AB=="),
        idempotencyKey: "request-1",
      }),
    ).toThrow();
    for (const collidingLastCharacter of ["B", "C", "D"]) {
      expect(() =>
        decodeClientWebSocketFrame(
          signedSyncChange({ frameID: `${"A".repeat(21)}${collidingLastCharacter}` }),
        ),
      ).toThrow();
    }
  });

  test("decodes the client hello and stable server error vectors", () => {
    expect(
      decodeClientWebSocketFrame({
        type: "hello",
        supportedProtocolVersions: [2],
        deviceID: "device-1",
        authEpoch: 3,
      }),
    ).toEqual({
      type: "hello",
      supportedProtocolVersions: [2],
      deviceID: "device-1",
      authEpoch: 3,
    });
    expect(
      decodeServerWebSocketFrame({
        type: "error",
        protocolVersion: 2,
        error: {
          code: "protocol_version_unsupported",
          message: "upgrade",
          retryable: false,
          supportedProtocolVersions: [2],
        },
      }),
    ).toEqual({
      type: "error",
      protocolVersion: 2,
      error: {
        code: "protocol_version_unsupported",
        message: "upgrade",
        retryable: false,
        supportedProtocolVersions: [2],
      },
    });
  });

  test("requires one signed replay nonce and produces fixed canonical bytes", () => {
    const frame = decodeClientWebSocketFrame({
      type: "syncChange",
      protocolVersion: 2,
      vaultID: "vault-1",
      deviceID: "device-1",
      authEpoch: 3,
      changeID: "change-1",
      causalVersion: 9,
      frameID: validFrameID,
      signingPayloadVersion: 1,
      payloadBase64: "AQI=",
      deviceSignature: p256SignatureBase64,
    });
    expect(frame.type).toBe("syncChange");
    if (frame.type !== "syncChange") throw new Error("Expected sync change");
    expect(Buffer.from(syncChangeSigningPayload(frame)).toString("base64")).toBe(
      "RU5DSFNZTkMBAAAAATIAAAAHdmF1bHQtMQAAAAhkZXZpY2UtMQAAAAEzAAAACGNoYW5nZS0xAAAAATkAAAAWQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQAAAARBUUk9",
    );
    const collisionCandidate = decodeClientWebSocketFrame({
      type: "syncChange",
      protocolVersion: 2,
      vaultID: "vault-1",
      deviceID: "device-1",
      authEpoch: 3,
      changeID: "change-1",
      causalVersion: 9,
      frameID: "AAAAAAAAAAAAAAAAAAAAAQ",
      signingPayloadVersion: 1,
      payloadBase64: "AQI=",
      deviceSignature: p256SignatureBase64,
    });
    if (collisionCandidate.type !== "syncChange") throw new Error("Expected sync change");
    expect(Buffer.from(syncChangeSigningPayload(frame)).toString("base64")).not.toBe(
      Buffer.from(syncChangeSigningPayload(collisionCandidate)).toString("base64"),
    );
    expect(() =>
      decodeClientWebSocketFrame({
        type: "syncChange",
        protocolVersion: 2,
        vaultID: "vault-1",
        deviceID: "device-1",
        authEpoch: 3,
        changeID: "change-1",
        causalVersion: 9,
        frameID: "frame-1",
        signingPayloadVersion: 1,
        payloadBase64: "AQI=",
        deviceSignature: p256SignatureBase64,
      }),
    ).toThrow();
  });

  test("keeps checked-in cross-language golden vectors decodable", async () => {
    const vector: unknown = JSON.parse(
      await readFile(resolve(packageRoot, "vectors/v2.json"), "utf8"),
    );
    const http = record(record(vector).http);
    const websocket = record(record(vector).websocket);
    expect(decodeDeviceRegisterRequest(http.registerDeviceRequest).protocolVersion).toBe(
      protocolVersion,
    );
    expect(decodeErrorEnvelope(http.unsupportedVersionError).error.code).toBe(
      "protocol_version_unsupported",
    );
    expect(decodeClientWebSocketFrame(websocket.hello).type).toBe("hello");
    expect(decodeServerWebSocketFrame(websocket.helloAccepted).type).toBe("helloAccepted");
    const signedSyncChange = decodeClientWebSocketFrame(websocket.signedSyncChange);
    expect(signedSyncChange.type).toBe("syncChange");
    if (signedSyncChange.type !== "syncChange") throw new Error("Expected sync change");
    expect(Buffer.from(syncChangeSigningPayload(signedSyncChange)).toString("base64")).toBe(
      string(websocket.signedSyncChangePayloadBase64),
    );
  });
});
