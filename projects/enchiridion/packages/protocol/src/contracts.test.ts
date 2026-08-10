import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSONSHA256,
  canonicalJSONStringify,
  canonicalizeQuery,
  decodeBlobDeleteRequestJSON,
  decodeClientWebSocketFrame,
  decodeClientWebSocketFrameJSON,
  decodeDeviceChallengeRequestJSON,
  decodeDeviceRegisterRequest,
  decodeDeviceRegisterRequestJSON,
  decodeDeviceRevokeRequest,
  decodeDeviceRevokeRequestJSON,
  decodeErrorEnvelope,
  decodeMutationRequestJSON,
  decodeServerWebSocketFrame,
  decodeServerWebSocketFrameJSON,
  decodeSignedRequestHeader,
  deviceChallengeProofSigningPayload,
  helloSigningPayload,
  isCanonicalP256LowSSignature,
  parseJSONWithoutDuplicateMembers,
  protocolVersion,
  rawJSONStructuralLimits,
  signedDeviceRequestSigningPayload,
  signedRequestHeader,
  signedRequestHeaderName,
  sha256Hex,
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
const opaquePayloadSHA256 = sha256Hex(Uint8Array.from([1, 2]));

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
    operationID: "operation-1",
    sourceKind: "websocket",
    payloadSHA256: opaquePayloadSHA256,
    causalVersion: 9,
    frameID: validFrameID,
    signingPayloadVersion: 1,
    payloadBase64: "AQI=",
    deviceSignature: p256SignatureBase64,
    ...overrides,
  };
}

function serverHelloChallenge(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    type: "serverHelloChallenge",
    protocolVersion,
    connectionNonce: validFrameID,
    issuedAt: 1_760_000_000_000,
    expiresAt: 1_760_000_120_000,
    ownerID: "owner-1",
    vaultID: "vault-1",
    authEpoch: 3,
    credentialEpoch: 4,
    generationEpoch: 5,
    ...overrides,
  };
}

function signedHello(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: "hello",
    protocolVersion,
    connectionNonce: validFrameID,
    resumeToken: "AAAAAAAAAAAAAAAAAAAAAA",
    deviceID: "device-1",
    authEpoch: 3,
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

function mutationRequest(): Record<string, unknown> {
  const command = {
    type: "mutation",
    operationID: "operation-1",
    deviceID: "device-1",
    sourceKind: "http",
    payloadSHA256: opaquePayloadSHA256,
    payloadBase64: "AQI=",
    causalVersion: 9,
  };
  return {
    envelope: signedEnvelope({
      canonicalPath: "/v2/mutations",
      targetDeviceID: undefined,
      bodySHA256: canonicalJSONSHA256(command),
    }),
    command,
  };
}

function blobDeleteRequest(): Record<string, unknown> {
  const command = { type: "blobDelete", blobSHA256: "b".repeat(64) };
  return {
    envelope: signedEnvelope({
      method: "DELETE",
      canonicalPath: `/v2/blobs/${command.blobSHA256}`,
      targetDeviceID: undefined,
      bodySHA256: canonicalJSONSHA256(command),
    }),
    command,
  };
}

function withDuplicateRootMember(source: string): string {
  return source.replace("{", '{"duplicate":null,"duplicate":null,');
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
    expect(
      decodeClientWebSocketFrame(
        signedSyncChange({
          payloadBase64: "AA==",
          payloadSHA256: sha256Hex(Uint8Array.from([0])),
        }),
      ).type,
    ).toBe("syncChange");
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

  test("decodes the challenged client hello and stable server error vectors", () => {
    expect(decodeClientWebSocketFrame(signedHello()).type).toBe("hello");
    expect(decodeServerWebSocketFrame(serverHelloChallenge()).type).toBe("serverHelloChallenge");
    expect(() =>
      decodeServerWebSocketFrame(serverHelloChallenge({ expiresAt: 1_760_000_000_500 })),
    ).toThrow("expiry");
    expect(() =>
      decodeServerWebSocketFrame(serverHelloChallenge({ expiresAt: 1_760_000_400_001 })),
    ).toThrow("expiry");
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
      operationID: "operation-1",
      sourceKind: "websocket",
      payloadSHA256: opaquePayloadSHA256,
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
      operationID: "operation-1",
      sourceKind: "websocket",
      payloadSHA256: opaquePayloadSHA256,
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
        operationID: "operation-1",
        sourceKind: "websocket",
        payloadSHA256: opaquePayloadSHA256,
        causalVersion: 9,
        frameID: "frame-1",
        signingPayloadVersion: 1,
        payloadBase64: "AQI=",
        deviceSignature: p256SignatureBase64,
      }),
    ).toThrow();
  });

  test("uses one opaque operation namespace and keeps causal metadata separate from server sequence", () => {
    const http = decodeMutationRequestJSON(JSON.stringify(mutationRequest()));
    const websocket = decodeClientWebSocketFrame(signedSyncChange());
    expect(http.command.operationID).toBe("operation-1");
    expect(websocket.type).toBe("syncChange");
    if (websocket.type !== "syncChange") throw new Error("Expected sync change");
    expect(websocket.operationID).toBe(http.command.operationID);
    expect(websocket.causalVersion).toBe(9);
    expect(
      decodeServerWebSocketFrame({
        type: "syncAcknowledged",
        protocolVersion,
        vaultID: "vault-1",
        operationID: "operation-1",
        logSequence: 17,
      }),
    ).toEqual({
      type: "syncAcknowledged",
      protocolVersion,
      vaultID: "vault-1",
      operationID: "operation-1",
      logSequence: 17,
    });
    expect(() =>
      decodeServerWebSocketFrame({
        type: "syncAcknowledged",
        protocolVersion,
        vaultID: "vault-1",
        operationID: "operation-1",
        logSequence: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeServerWebSocketFrame({
        type: "syncAcknowledged",
        protocolVersion,
        vaultID: "vault-1",
        operationID: "operation-1",
        causalVersion: 9,
        logSequence: 17,
      }),
    ).toThrow("unknown key causalVersion");

    const mismatchedDevice = mutationRequest() as {
      envelope: Record<string, unknown>;
      command: Record<string, unknown>;
    };
    mismatchedDevice.command.deviceID = "device-2";
    mismatchedDevice.envelope.bodySHA256 = canonicalJSONSHA256(mismatchedDevice.command as never);
    expect(() => decodeMutationRequestJSON(JSON.stringify(mismatchedDevice))).toThrow(
      "device must match",
    );

    const mismatchedPayload = mutationRequest() as {
      envelope: Record<string, unknown>;
      command: Record<string, unknown>;
    };
    mismatchedPayload.command.payloadSHA256 = "a".repeat(64);
    mismatchedPayload.envelope.bodySHA256 = canonicalJSONSHA256(mismatchedPayload.command as never);
    expect(() => decodeMutationRequestJSON(JSON.stringify(mismatchedPayload))).toThrow(
      "payload digest",
    );
    expect(() => decodeClientWebSocketFrame(signedSyncChange({ sourceKind: "http" }))).toThrow();
    expect(decodeClientWebSocketFrame(signedSyncChange({ causalVersion: undefined })).type).toBe(
      "syncChange",
    );
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
      decodeServerWebSocketFrameJSON(
        JSON.stringify(serverHelloChallenge()).replace(
          `"connectionNonce":"${validFrameID}",`,
          `"connectionNonce":"${validFrameID}","connectionNonce":"${validFrameID}",`,
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeClientWebSocketFrameJSON(
        JSON.stringify(signedHello()).replace(
          `"connectionNonce":"${validFrameID}",`,
          `"connectionNonce":"${validFrameID}","connectionNonce":"${validFrameID}",`,
        ),
      ),
    ).toThrow();
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

  test("binds the server challenge and nullable resume token in ENCHWSHELLO v1", () => {
    const challenge = decodeServerWebSocketFrame(serverHelloChallenge());
    if (challenge.type !== "serverHelloChallenge") throw new Error("Expected server challenge");
    const hello = decodeClientWebSocketFrame(signedHello());
    if (hello.type !== "hello") throw new Error("Expected hello");
    const baseline = Buffer.from(helloSigningPayload(hello, challenge, 1_760_000_000_001)).toString(
      "base64",
    );
    for (const changedChallenge of [
      serverHelloChallenge({ ownerID: "owner-2" }),
      serverHelloChallenge({ vaultID: "vault-2" }),
      serverHelloChallenge({ authEpoch: 4 }),
      serverHelloChallenge({ credentialEpoch: 5 }),
      serverHelloChallenge({ generationEpoch: 6 }),
      serverHelloChallenge({ issuedAt: 1_760_000_001_000, expiresAt: 1_760_000_121_000 }),
    ]) {
      const decoded = decodeServerWebSocketFrame(changedChallenge);
      if (decoded.type !== "serverHelloChallenge") throw new Error("Expected server challenge");
      expect(
        Buffer.from(helloSigningPayload(hello, decoded, 1_760_000_000_001)).toString("base64"),
      ).not.toBe(baseline);
    }
    const changedNonceChallenge = decodeServerWebSocketFrame(
      serverHelloChallenge({ connectionNonce: "AAAAAAAAAAAAAAAAAAAAAQ" }),
    );
    const changedNonceHello = decodeClientWebSocketFrame(
      signedHello({ connectionNonce: "AAAAAAAAAAAAAAAAAAAAAQ" }),
    );
    if (changedNonceChallenge.type !== "serverHelloChallenge" || changedNonceHello.type !== "hello")
      throw new Error("Expected challenged hello");
    expect(
      Buffer.from(
        helloSigningPayload(changedNonceHello, changedNonceChallenge, 1_760_000_000_001),
      ).toString("base64"),
    ).not.toBe(baseline);
    const resumed = decodeClientWebSocketFrame(signedHello({ resumeToken: undefined }));
    if (resumed.type !== "hello") throw new Error("Expected hello");
    expect(
      Buffer.from(helloSigningPayload(resumed, challenge, 1_760_000_000_001)).toString("base64"),
    ).not.toBe(baseline);
    expect(() =>
      helloSigningPayload(
        hello,
        decodeServerWebSocketFrame(
          serverHelloChallenge({ connectionNonce: "AAAAAAAAAAAAAAAAAAAAAQ" }),
        ) as never,
        1_760_000_000_001,
      ),
    ).toThrow("echo");
    expect(() => helloSigningPayload(hello, challenge, 1_760_000_120_000)).toThrow("expired");
    expect(() => helloSigningPayload(hello, challenge, Number.NaN)).toThrow("safe integer");
    expect(() =>
      decodeClientWebSocketFrame(signedHello({ resumeToken: "A".repeat(513) })),
    ).toThrow();
  });

  test("uses a bounded linear raw JSON pass before HTTP and WebSocket decoding", () => {
    expect(decodeDeviceRegisterRequestJSON(JSON.stringify(registration())).idempotencyKey).toBe(
      "request-1",
    );
    expect(decodeClientWebSocketFrameJSON(JSON.stringify(signedSyncChange())).type).toBe(
      "syncChange",
    );

    expect(parseJSONWithoutDuplicateMembers('{"escaped":"\\\\u0061"}')).toEqual({
      escaped: "\\u0061",
    });
    expect(parseJSONWithoutDuplicateMembers('{"escaped":"\\uD83D\\uDE00"}')).toEqual({
      escaped: "😀",
    });
    for (const loneSurrogate of ['"\\uD800"', '"\\uDC00"', `"${String.fromCharCode(0xd800)}"`])
      expect(() => parseJSONWithoutDuplicateMembers(loneSurrogate)).toThrow(
        "lone UTF-16 surrogates",
      );
    expect(() => parseJSONWithoutDuplicateMembers('{"\\u0064uplicate":1,"duplicate":2}')).toThrow(
      "Duplicate JSON member",
    );
    expect(() =>
      parseJSONWithoutDuplicateMembers(
        `[${"[".repeat(rawJSONStructuralLimits.nestingDepth + 1)}0${"]".repeat(
          rawJSONStructuralLimits.nestingDepth + 1,
        )}]`,
      ),
    ).toThrow("JSON nesting exceeds");
    expect(() =>
      parseJSONWithoutDuplicateMembers(
        JSON.stringify(
          Object.fromEntries(
            Array.from({ length: rawJSONStructuralLimits.membersPerContainer + 1 }, (_, index) => [
              `member${index}`,
              index,
            ]),
          ),
        ),
      ),
    ).toThrow("JSON object members exceed");
    expect(() =>
      parseJSONWithoutDuplicateMembers(
        `"${"x".repeat(rawJSONStructuralLimits.stringCodeUnits + 1)}"`,
      ),
    ).toThrow("JSON string exceeds");
    expect(() =>
      parseJSONWithoutDuplicateMembers("1".repeat(rawJSONStructuralLimits.numberCodeUnits + 1)),
    ).toThrow("JSON number exceeds");
    expect(() =>
      parseJSONWithoutDuplicateMembers(" ".repeat(rawJSONStructuralLimits.inputCodeUnits + 1)),
    ).toThrow("JSON input exceeds");
  });

  test("keeps every raw ingress wrapper duplicate-free before schema decoding", () => {
    const rawMutation = JSON.stringify(mutationRequest());
    const rawBlobDelete = JSON.stringify(blobDeleteRequest());
    const rawServerFrame = JSON.stringify({
      type: "error",
      protocolVersion,
      error: { code: "invalid_request", message: "invalid", retryable: false },
    });
    expect(decodeMutationRequestJSON(rawMutation).command.type).toBe("mutation");
    expect(decodeBlobDeleteRequestJSON(rawBlobDelete).command.type).toBe("blobDelete");
    expect(decodeServerWebSocketFrameJSON(rawServerFrame).type).toBe("error");
    expect(() => decodeMutationRequestJSON(withDuplicateRootMember(rawMutation))).toThrow(
      "Duplicate JSON member",
    );
    expect(() => decodeBlobDeleteRequestJSON(withDuplicateRootMember(rawBlobDelete))).toThrow(
      "Duplicate JSON member",
    );
    expect(() => decodeServerWebSocketFrameJSON(withDuplicateRootMember(rawServerFrame))).toThrow(
      "Duplicate JSON member",
    );

    const envelope = decodeDeviceRevokeRequest({
      envelope: signedEnvelope(),
      command: { type: "deviceRevoke", actorDeviceID: "device-1", targetDeviceID: "device-2" },
    }).envelope;
    const header = signedRequestHeader(envelope);
    expect(decodeSignedRequestHeader([header])).toEqual(envelope);
    expect(() =>
      decodeSignedRequestHeader([
        {
          name: signedRequestHeaderName,
          value: Buffer.from(withDuplicateRootMember(JSON.stringify(signedEnvelope()))).toString(
            "base64url",
          ),
        },
      ]),
    ).toThrow("Duplicate JSON member");
    expect(() =>
      decodeSignedRequestHeader([{ name: signedRequestHeaderName, value: "_w" }]),
    ).toThrow("valid UTF-8");
    expect(() =>
      decodeSignedRequestHeader([
        {
          name: signedRequestHeaderName,
          value: Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(header.value, "base64url"),
          ]).toString("base64url"),
        },
      ]),
    ).toThrow("Invalid JSON value");
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
    const serverHelloChallenge = decodeServerWebSocketFrame(websocket.serverHelloChallenge);
    expect(serverHelloChallenge.type).toBe("serverHelloChallenge");
    const hello = decodeClientWebSocketFrame(websocket.hello);
    expect(hello.type).toBe("hello");
    if (serverHelloChallenge.type !== "serverHelloChallenge" || hello.type !== "hello")
      throw new Error("Expected challenged hello vector");
    expect(
      Buffer.from(helloSigningPayload(hello, serverHelloChallenge, 1_760_000_000_001)).toString(
        "base64",
      ),
    ).toBe(string(websocket.helloSigningPayloadBase64));
    expect(decodeServerWebSocketFrame(websocket.helloAccepted).type).toBe("helloAccepted");
    const signedSyncChange = decodeClientWebSocketFrame(websocket.signedSyncChange);
    expect(signedSyncChange.type).toBe("syncChange");
    if (signedSyncChange.type !== "syncChange") throw new Error("Expected sync change");
    expect(Buffer.from(syncChangeSigningPayload(signedSyncChange)).toString("base64")).toBe(
      string(websocket.signedSyncChangePayloadBase64),
    );
  });
});
