import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSONSHA256,
  canonicalJSONStringify,
  canonicalizeQuery,
  decodeClientWebSocketFrame,
  decodeClientWebSocketFrameJSON,
  decodeDeviceChallengeRequestJSON,
  decodeDeviceRegisterRequest,
  decodeDeviceRegisterRequestJSON,
  decodeDeviceRevokeRequest,
  decodeDeviceRevokeRequestJSON,
  decodeErrorEnvelope,
  decodeServerWebSocketFrame,
  deviceChallengeProofSigningPayload,
  isCanonicalP256LowSSignature,
  parseJSONWithoutDuplicateMembers,
  protocolVersion,
  signedDeviceRequestSigningPayload,
  syncChangeSigningPayload,
  websocketContract,
} from "./contracts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const p256SignatureBase64 = "MAYCAQECAQE=";
const p256LowSSignatureBase64 =
  "MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==";
const p256HighSSignatureBase64 =
  "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=";
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
    credentialEpoch: 4,
    generationEpoch: 5,
    sessionNonce: validFrameID,
    assertionExpiresAt: 1_760_000_120_000,
    changeID: "change-1",
    causalVersion: 9,
    frameID: validFrameID,
    signingPayloadVersion: 1,
    payloadBase64: "AQI=",
    deviceSignature: p256SignatureBase64,
    ...overrides,
  };
}

function signedEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    protocolVersion,
    method: "POST",
    canonicalPath: "/v2/devices/device-1/revoke",
    canonicalQuery: "",
    bodySHA256: "c93e5235c7c4ec77b35910f85a4a16ba036385cc57a157220224afaf90a578d3",
    requestID: "request-1",
    idempotencyKey: "idem-1",
    ownerID: "owner-1",
    vaultID: "vault-1",
    generationEpoch: 5,
    actorDeviceID: "device-1",
    targetDeviceID: "device-2",
    authEpoch: 3,
    credentialEpoch: 4,
    issuedAt: 1_760_000_000_000,
    expiresAt: 1_760_000_120_000,
    nonce: validFrameID,
    deviceSignature: p256SignatureBase64,
    ...overrides,
  };
}

function registrationProof(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    protocolVersion,
    challengeID: "challenge-1",
    challengeAudience: "enchiridion",
    challengeBase64: "AQI=",
    expiresAt: 1_760_000_120_000,
    nonce: validFrameID,
    devicePublicKey: p256SPKIBase64,
    signature: p256SignatureBase64,
    ...overrides,
  };
}
function registration(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    challengeProof: registrationProof(),
    idempotencyKey: "request-1",
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
    expect(decodeDeviceRegisterRequest(registration())).toMatchObject({
      idempotencyKey: "request-1",
    });
  });

  test("accepts only the canonical low-S P-256 DER wire profile", () => {
    expect(isCanonicalP256LowSSignature(p256LowSSignatureBase64)).toBe(true);
    expect(isCanonicalP256LowSSignature(p256HighSSignatureBase64)).toBe(false);
    expect(isCanonicalP256LowSSignature("MAYCAQACAQE=")).toBe(false);
    expect(
      decodeDeviceRegisterRequest(
        registration({ challengeProof: registrationProof({ signature: p256LowSSignatureBase64 }) }),
      ).challengeProof.signature,
    ).toBe(p256LowSSignatureBase64);
    expect(() =>
      decodeDeviceRegisterRequest(
        registration({
          challengeProof: registrationProof({ signature: p256HighSSignatureBase64 }),
        }),
      ),
    ).toThrow();
  });

  test("reject unknown and invalid public values at the boundary", () => {
    expect(() =>
      decodeDeviceRegisterRequest(
        registration({ challengeProof: registrationProof({ challengeID: "" }) }),
      ),
    ).toThrow();
    expect(() =>
      decodeDeviceRegisterRequest(
        registration({ challengeProof: registrationProof({ signature: "MAYCAQECAQEA" }) }),
      ),
    ).toThrow();
    expect(() =>
      decodeDeviceRegisterRequest(
        registration({
          challengeProof: registrationProof({
            devicePublicKey: `${p256SPKIBase64.slice(0, -4)}AQID`,
          }),
        }),
      ),
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
        deviceSignature: p256SignatureBase64,
      }),
    ).toEqual({
      type: "hello",
      supportedProtocolVersions: [2],
      deviceID: "device-1",
      deviceSignature: p256SignatureBase64,
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
      credentialEpoch: 4,
      generationEpoch: 5,
      sessionNonce: validFrameID,
      assertionExpiresAt: 1_760_000_120_000,
      changeID: "change-1",
      causalVersion: 9,
      frameID: validFrameID,
      signingPayloadVersion: 1,
      payloadBase64: "AQI=",
      deviceSignature: p256SignatureBase64,
    });
    expect(frame.type).toBe("syncChange");
    if (frame.type !== "syncChange") throw new Error("Expected sync change");
    const canonicalBytes = Buffer.from(syncChangeSigningPayload(frame)).toString("base64");
    expect(canonicalBytes).not.toBe("");
    for (const mutation of [
      { credentialEpoch: 6 },
      { generationEpoch: 6 },
      { sessionNonce: "AAAAAAAAAAAAAAAAAAAAAQ" },
      { assertionExpiresAt: 1_760_000_121_000 },
    ]) {
      const candidate = decodeClientWebSocketFrame(signedSyncChange(mutation));
      if (candidate.type !== "syncChange") throw new Error("Expected sync change");
      expect(Buffer.from(syncChangeSigningPayload(candidate)).toString("base64")).not.toBe(
        canonicalBytes,
      );
    }
    const collisionCandidate = decodeClientWebSocketFrame({
      type: "syncChange",
      protocolVersion: 2,
      vaultID: "vault-1",
      deviceID: "device-1",
      authEpoch: 3,
      credentialEpoch: 4,
      generationEpoch: 5,
      sessionNonce: validFrameID,
      assertionExpiresAt: 1_760_000_120_000,
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
        credentialEpoch: 4,
        generationEpoch: 5,
        sessionNonce: validFrameID,
        assertionExpiresAt: 1_760_000_120_000,
        changeID: "change-1",
        causalVersion: 9,
        frameID: "frame-1",
        signingPayloadVersion: 1,
        payloadBase64: "AQI=",
        deviceSignature: p256SignatureBase64,
      }),
    ).toThrow();
  });

  test("binds canonical JSON and every signed revoke field into unambiguous request bytes", () => {
    expect(canonicalJSONStringify({ z: "\\n", a: [2, "<"] })).toBe('{"a":[2,"<"],"z":"\\\\n"}');
    expect(
      canonicalizeQuery([
        ["z", "a b"],
        ["a", "!"],
      ]),
    ).toBe("a=%21&z=a%20b");
    const request = decodeDeviceRevokeRequest({
      envelope: signedEnvelope(),
      command: { type: "deviceRevoke", actorDeviceID: "device-1", targetDeviceID: "device-2" },
    });
    expect(
      Buffer.from(signedDeviceRequestSigningPayload(request.envelope)).toString("base64"),
    ).not.toBe("");
    expect(() =>
      decodeDeviceRevokeRequest({
        envelope: signedEnvelope({ targetDeviceID: "device-3" }),
        command: { type: "deviceRevoke", actorDeviceID: "device-1", targetDeviceID: "device-2" },
      }),
    ).toThrow();
  });

  test("binds every issued challenge field and rejects duplicate signed JSON members", () => {
    const proof = decodeDeviceRegisterRequest(registration()).challengeProof;
    const baseline = Buffer.from(deviceChallengeProofSigningPayload(proof)).toString("base64");
    const changed = decodeDeviceRegisterRequest(
      registration({ challengeProof: registrationProof({ nonce: "AAAAAAAAAAAAAAAAAAAAAQ" }) }),
    ).challengeProof;
    expect(Buffer.from(deviceChallengeProofSigningPayload(changed)).toString("base64")).not.toBe(
      baseline,
    );
    expect(() => parseJSONWithoutDuplicateMembers('{"envelope":{},"envelope":{}}')).toThrow();
    expect(() =>
      decodeDeviceRevokeRequestJSON('{"envelope":{},"envelope":{},"command":{}}'),
    ).toThrow();
    expect(() => decodeClientWebSocketFrameJSON('{"type":"hello","type":"hello"}')).toThrow();
    expect(() =>
      decodeDeviceChallengeRequestJSON(
        `{"protocolVersion":2,"protocolVersion":2,"devicePublicKey":"${p256SPKIBase64}","challengeAudience":"enchiridion"}`,
      ),
    ).toThrow();
    const registrationJSON = JSON.stringify(registration());
    expect(() =>
      decodeDeviceRegisterRequestJSON(
        registrationJSON.replace(
          `"nonce":"${validFrameID}",`,
          `"nonce":"${validFrameID}","nonce":"${validFrameID}",`,
        ),
      ),
    ).toThrow();
  });

  test("keeps checked-in cross-language golden vectors decodable", async () => {
    const vector: unknown = JSON.parse(
      await readFile(resolve(packageRoot, "vectors/v2.json"), "utf8"),
    );
    const http = record(record(vector).http);
    const websocket = record(record(vector).websocket);
    const canonicalJSON = record(http.canonicalJSON);
    const p256SignatureProfile = record(http.p256SignatureProfile);
    expect(isCanonicalP256LowSSignature(string(p256SignatureProfile.lowSSignatureDERBase64))).toBe(
      true,
    );
    expect(
      isCanonicalP256LowSSignature(string(p256SignatureProfile.highSSignatureDERBase64Rejected)),
    ).toBe(false);
    expect(canonicalJSONStringify(canonicalJSON.input as never)).toBe(
      string(canonicalJSON.canonical),
    );
    expect(canonicalJSONSHA256(canonicalJSON.input as never)).toBe(string(canonicalJSON.sha256));
    expect(
      decodeDeviceRegisterRequest(http.registerDeviceRequest).challengeProof.protocolVersion,
    ).toBe(protocolVersion);
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
