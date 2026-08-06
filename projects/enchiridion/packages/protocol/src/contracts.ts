import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

/** The single wire version emitted and accepted by this package. */
export const protocolVersion = 2 as const;
export const supportedProtocolVersions = [protocolVersion] as const;
export const syncFrameSigningPayloadVersion = 1 as const;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TEXT_LENGTH = 512;
const MAX_PAYLOAD_BASE64_LENGTH = 1_398_104; // 1 MiB decoded payload.
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const p256DerBase64 = /^(?=M)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const opaqueIdentifier = /^[A-Za-z0-9._~-]+$/;
const frameID = /^[A-Za-z0-9_-]{22}$/;
const p256SPKIPrefix = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);

function decodedBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodedBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Rejects alternate textual spellings, including nonzero unused padding bits. */
function canonicalBase64Bytes(value: string): Uint8Array | undefined {
  try {
    const bytes = decodedBase64(value);
    return encodedBase64(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalBase64(value: string): boolean {
  return canonicalBase64Bytes(value) !== undefined;
}

function isCanonicalFrameID(value: string): boolean {
  if (!frameID.test(value)) return false;
  const standardBase64 = `${value.replace(/-/g, "+").replace(/_/g, "/")}==`;
  const bytes = canonicalBase64Bytes(standardBase64);
  if (bytes === undefined || bytes.length !== 16) return false;
  return encodedBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value;
}

function derLength(bytes: Uint8Array, offset: number): readonly [number, number] | undefined {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  if (first < 0x80) return [first, offset + 1];
  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 2 || offset + byteCount >= bytes.length) return undefined;
  let length = 0;
  for (let index = 1; index <= byteCount; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined || (index === 1 && byte === 0)) return undefined;
    length = (length << 8) | byte;
  }
  if (length < 0x80) return undefined;
  return [length, offset + byteCount + 1];
}

function derPositiveIntegerEnd(bytes: Uint8Array, offset: number): number | undefined {
  if (bytes[offset] !== 0x02) return undefined;
  const length = derLength(bytes, offset + 1);
  if (length === undefined) return undefined;
  const [size, contentOffset] = length;
  const end = contentOffset + size;
  if (size < 1 || size > 33 || end > bytes.length) return undefined;
  const first = bytes[contentOffset];
  const second = bytes[contentOffset + 1];
  if (first === undefined) return undefined;
  if ((first & 0x80) !== 0) return undefined;
  if (size > 1 && first === 0 && second !== undefined && (second & 0x80) === 0) return undefined;
  return end;
}

function isCanonicalP256Signature(value: string): boolean {
  const bytes = canonicalBase64Bytes(value);
  if (bytes === undefined) return false;
  if (bytes[0] !== 0x30) return false;
  const sequence = derLength(bytes, 1);
  if (sequence === undefined) return false;
  const [size, contentOffset] = sequence;
  if (contentOffset + size !== bytes.length) return false;
  const rEnd = derPositiveIntegerEnd(bytes, contentOffset);
  if (rEnd === undefined) return false;
  const sEnd = derPositiveIntegerEnd(bytes, rEnd);
  return sEnd === bytes.length;
}

function isCanonicalP256SPKI(value: string): boolean {
  const bytes = canonicalBase64Bytes(value);
  if (bytes === undefined) return false;
  if (bytes.length !== 91 || p256SPKIPrefix.some((byte, index) => bytes[index] !== byte))
    return false;
  return bytes.slice(p256SPKIPrefix.length).length === 64;
}

const named =
  (identifier: string) =>
  <A, I, R>(schema: Schema.Schema<A, I, R>): Schema.Schema<A, I, R> =>
    schema.annotations({ identifier });
const text = (maximum = MAX_TEXT_LENGTH) =>
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(maximum), named(`Text${maximum}`));
const identifier = (identifierName: string) =>
  Schema.String.pipe(
    Schema.pattern(opaqueIdentifier),
    Schema.minLength(1),
    Schema.maxLength(MAX_IDENTIFIER_LENGTH),
    named(identifierName),
  );
const canonicalBase64 = (minimum: number, maximum: number, identifierName: string) =>
  Schema.String.pipe(
    Schema.pattern(base64),
    Schema.minLength(minimum),
    Schema.maxLength(maximum),
    Schema.filter(isCanonicalBase64),
    Schema.annotations({ jsonSchema: { format: "base64-canonical", maxLength: maximum } }),
    named(identifierName),
  );
const nonNegativeInt = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  named("NonNegativeInt"),
);

/** Application identity is opaque: it is never an Access subject or email. */
export const OwnerIDSchema = identifier("OwnerID");
export const DeviceIDSchema = identifier("DeviceID");
export const VaultIDSchema = identifier("VaultID");
export const FrameIDSchema = Schema.String.pipe(
  Schema.pattern(frameID),
  Schema.filter(isCanonicalFrameID),
  Schema.annotations({ jsonSchema: { format: "base64url-128" } }),
  named("FrameID"),
);
export const ProtocolVersionSchema = Schema.Literal(protocolVersion).pipe(named("ProtocolVersion"));
export const Base64PayloadSchema = canonicalBase64(4, MAX_PAYLOAD_BASE64_LENGTH, "Base64Payload");
/** Canonical uncompressed P-256 SubjectPublicKeyInfo DER, base64 encoded (91 bytes). */
export const P256SPKIBase64Schema = Schema.String.pipe(
  Schema.pattern(p256DerBase64),
  Schema.minLength(124),
  Schema.maxLength(124),
  Schema.filter(isCanonicalP256SPKI),
  Schema.annotations({ jsonSchema: { format: "p256-spki-der", maxLength: 124 } }),
  named("P256SPKI"),
);
/** Canonical P-256 ECDSA DER sequence with positive R/S integers, base64 encoded. */
export const P256SignatureBase64Schema = Schema.String.pipe(
  Schema.pattern(p256DerBase64),
  Schema.minLength(12),
  Schema.maxLength(96),
  Schema.filter(isCanonicalP256Signature),
  Schema.annotations({ jsonSchema: { format: "p256-ecdsa-der", maxLength: 96 } }),
  named("P256Signature"),
);

export const ErrorCodeSchema = Schema.Literal(
  "access_token_invalid",
  "authorization_failed",
  "device_revoked",
  "invalid_request",
  "not_found",
  "protocol_version_unsupported",
  "replay_detected",
  "request_conflict",
  "temporarily_unavailable",
  "unauthorized",
).pipe(named("ErrorCode"));

/** This is read from the literal Schema AST, never duplicated for generators. */
function literalStrings(schemaAST: AST.AST): readonly string[] {
  if (!AST.isUnion(schemaAST)) throw new TypeError("Error code schema must be a literal union.");
  return schemaAST.types.flatMap((member) => {
    if (!AST.isLiteral(member) || typeof member.literal !== "string")
      throw new TypeError("Error code schema must contain string literals.");
    return [member.literal];
  });
}
export const errorCodes = literalStrings(ErrorCodeSchema.ast);

/** Stable public error body for every HTTP and WebSocket failure. */
export const ErrorBodySchema = Schema.Struct({
  code: ErrorCodeSchema,
  message: text(),
  retryable: Schema.Boolean,
  requestID: Schema.optional(identifier("Identifier")),
  supportedProtocolVersions: Schema.optional(
    Schema.Array(ProtocolVersionSchema).pipe(Schema.minItems(1), Schema.maxItems(1)),
  ),
}).pipe(named("ErrorBody"));

export const ErrorEnvelopeSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  error: ErrorBodySchema,
}).pipe(named("ErrorEnvelope"));

export const DeviceRegisterRequestShapeSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  challengeID: identifier("Identifier"),
  challengeAudience: text(256),
  challengeProof: P256SignatureBase64Schema,
  devicePublicKey: P256SPKIBase64Schema,
  idempotencyKey: identifier("Identifier"),
});
export const DeviceRegisterRequestSchema = DeviceRegisterRequestShapeSchema.pipe(
  named("DeviceRegisterRequest"),
);

export const DeviceRegisterResponseSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  ownerID: OwnerIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: nonNegativeInt,
}).pipe(named("DeviceRegisterResponse"));

export const DeviceRevokeRequestSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  idempotencyKey: identifier("Identifier"),
}).pipe(named("DeviceRevokeRequest"));

export const DeviceRevokeResponseSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  ownerID: OwnerIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: nonNegativeInt,
  revokedAt: text(64),
}).pipe(named("DeviceRevokeResponse"));

/** First client frame. No application message is valid before a hello. */
export const HelloFrameSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  supportedProtocolVersions: Schema.Array(ProtocolVersionSchema).pipe(
    Schema.minItems(1),
    Schema.maxItems(1),
  ),
  deviceID: DeviceIDSchema,
  authEpoch: nonNegativeInt,
}).pipe(named("HelloFrame"));

export const HelloAcceptedFrameSchema = Schema.Struct({
  type: Schema.Literal("helloAccepted"),
  protocolVersion: ProtocolVersionSchema,
  ownerID: OwnerIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: nonNegativeInt,
}).pipe(named("HelloAcceptedFrame"));

export const SyncChangeFrameSchema = Schema.Struct({
  type: Schema.Literal("syncChange"),
  protocolVersion: ProtocolVersionSchema,
  vaultID: VaultIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: nonNegativeInt,
  changeID: identifier("Identifier"),
  causalVersion: nonNegativeInt,
  /** Immutable 128-bit base64url nonce. Servers claim it before applying a change. */
  frameID: FrameIDSchema,
  signingPayloadVersion: Schema.Literal(syncFrameSigningPayloadVersion).pipe(
    named("SigningPayloadVersion"),
  ),
  payloadBase64: Base64PayloadSchema,
  /** P-256 DER ECDSA signature of `syncChangeSigningPayload(frame)`. */
  deviceSignature: P256SignatureBase64Schema,
}).pipe(named("SyncChangeFrame"));

export const SyncAcknowledgedFrameSchema = Schema.Struct({
  type: Schema.Literal("syncAcknowledged"),
  protocolVersion: ProtocolVersionSchema,
  vaultID: VaultIDSchema,
  changeID: identifier("Identifier"),
  causalVersion: nonNegativeInt,
}).pipe(named("SyncAcknowledgedFrame"));

export const ProtocolErrorFrameSchema = Schema.Struct({
  type: Schema.Literal("error"),
  protocolVersion: ProtocolVersionSchema,
  error: ErrorBodySchema,
}).pipe(named("ProtocolErrorFrame"));

export const ClientWebSocketFrameSchema = Schema.Union(HelloFrameSchema, SyncChangeFrameSchema);
export const ServerWebSocketFrameSchema = Schema.Union(
  HelloAcceptedFrameSchema,
  SyncAcknowledgedFrameSchema,
  ProtocolErrorFrameSchema,
);

/** The sole public model registry. Artifact and Swift generation consume it. */
export const protocolSchemaDefinitions = {
  ErrorBody: ErrorBodySchema,
  ErrorEnvelope: ErrorEnvelopeSchema,
  DeviceRegisterRequest: DeviceRegisterRequestSchema,
  DeviceRegisterResponse: DeviceRegisterResponseSchema,
  DeviceRevokeRequest: DeviceRevokeRequestSchema,
  DeviceRevokeResponse: DeviceRevokeResponseSchema,
  HelloFrame: HelloFrameSchema,
  HelloAcceptedFrame: HelloAcceptedFrameSchema,
  SyncChangeFrame: SyncChangeFrameSchema,
  SyncAcknowledgedFrame: SyncAcknowledgedFrameSchema,
  ProtocolErrorFrame: ProtocolErrorFrameSchema,
  ClientWebSocketFrame: ClientWebSocketFrameSchema,
  ServerWebSocketFrame: ServerWebSocketFrameSchema,
} as const;

export type ErrorEnvelope = Schema.Schema.Type<typeof ErrorEnvelopeSchema>;
export type ErrorCode = Schema.Schema.Type<typeof ErrorCodeSchema>;
export type DeviceRegisterRequest = Schema.Schema.Type<typeof DeviceRegisterRequestSchema>;
export type DeviceRegisterResponse = Schema.Schema.Type<typeof DeviceRegisterResponseSchema>;
export type DeviceRevokeRequest = Schema.Schema.Type<typeof DeviceRevokeRequestSchema>;
export type DeviceRevokeResponse = Schema.Schema.Type<typeof DeviceRevokeResponseSchema>;
export type ClientWebSocketFrame = Schema.Schema.Type<typeof ClientWebSocketFrameSchema>;
export type ServerWebSocketFrame = Schema.Schema.Type<typeof ServerWebSocketFrameSchema>;
export type SyncChangeFrame = Schema.Schema.Type<typeof SyncChangeFrameSchema>;

const decodeErrorEnvelopeSchema = Schema.decodeUnknownSync(ErrorEnvelopeSchema);
const decodeDeviceRegisterRequestSchema = Schema.decodeUnknownSync(DeviceRegisterRequestSchema);
const decodeDeviceRegisterResponseSchema = Schema.decodeUnknownSync(DeviceRegisterResponseSchema);
const decodeDeviceRevokeRequestSchema = Schema.decodeUnknownSync(DeviceRevokeRequestSchema);
const decodeDeviceRevokeResponseSchema = Schema.decodeUnknownSync(DeviceRevokeResponseSchema);
const decodeClientWebSocketFrameSchema = Schema.decodeUnknownSync(ClientWebSocketFrameSchema);
const decodeServerWebSocketFrameSchema = Schema.decodeUnknownSync(ServerWebSocketFrameSchema);

const errorBodyKeys = ["code", "message", "retryable", "requestID", "supportedProtocolVersions"];
const errorEnvelopeKeys = ["protocolVersion", "error"];
const registerRequestKeys = [
  "protocolVersion",
  "challengeID",
  "challengeAudience",
  "challengeProof",
  "devicePublicKey",
  "idempotencyKey",
];
const registerResponseKeys = ["protocolVersion", "ownerID", "deviceID", "authEpoch"];
const revokeRequestKeys = ["protocolVersion", "idempotencyKey"];
const revokeResponseKeys = ["protocolVersion", "ownerID", "deviceID", "authEpoch", "revokedAt"];
const helloKeys = ["type", "supportedProtocolVersions", "deviceID", "authEpoch"];
const helloAcceptedKeys = ["type", "protocolVersion", "ownerID", "deviceID", "authEpoch"];
const syncChangeKeys = [
  "type",
  "protocolVersion",
  "vaultID",
  "deviceID",
  "authEpoch",
  "changeID",
  "causalVersion",
  "frameID",
  "signingPayloadVersion",
  "payloadBase64",
  "deviceSignature",
];
const syncAcknowledgedKeys = ["type", "protocolVersion", "vaultID", "changeID", "causalVersion"];
const protocolErrorKeys = ["type", "protocolVersion", "error"];

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: unknown,
  allowedKeys: readonly string[],
  name: string,
): Record<string, unknown> {
  const object = record(value, name);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.includes(key)) throw new TypeError(`${name} contains unknown key ${key}.`);
  }
  return object;
}

function strictErrorBody(value: unknown): void {
  rejectUnknownKeys(value, errorBodyKeys, "error");
}

function requireCanonicalP256Signature(value: unknown, name: string): void {
  if (typeof value !== "string" || !isCanonicalP256Signature(value))
    throw new TypeError(`${name} must be canonical P-256 ECDSA DER base64.`);
}

function requireCanonicalP256SPKI(value: unknown, name: string): void {
  if (typeof value !== "string" || !isCanonicalP256SPKI(value))
    throw new TypeError(`${name} must be canonical P-256 SPKI DER base64.`);
}

export function decodeErrorEnvelope(input: unknown): ErrorEnvelope {
  const envelope = rejectUnknownKeys(input, errorEnvelopeKeys, "error envelope");
  strictErrorBody(envelope.error);
  return decodeErrorEnvelopeSchema(envelope);
}
export function decodeDeviceRegisterRequest(input: unknown): DeviceRegisterRequest {
  const request = rejectUnknownKeys(input, registerRequestKeys, "device register request");
  requireCanonicalP256Signature(request.challengeProof, "challengeProof");
  requireCanonicalP256SPKI(request.devicePublicKey, "devicePublicKey");
  return decodeDeviceRegisterRequestSchema(request);
}
export function decodeDeviceRegisterResponse(input: unknown): DeviceRegisterResponse {
  return decodeDeviceRegisterResponseSchema(
    rejectUnknownKeys(input, registerResponseKeys, "device register response"),
  );
}
export function decodeDeviceRevokeRequest(input: unknown): DeviceRevokeRequest {
  return decodeDeviceRevokeRequestSchema(
    rejectUnknownKeys(input, revokeRequestKeys, "device revoke request"),
  );
}
export function decodeDeviceRevokeResponse(input: unknown): DeviceRevokeResponse {
  return decodeDeviceRevokeResponseSchema(
    rejectUnknownKeys(input, revokeResponseKeys, "device revoke response"),
  );
}
export function decodeClientWebSocketFrame(input: unknown): ClientWebSocketFrame {
  const frame = record(input, "client websocket frame");
  if (frame.type === "hello") rejectUnknownKeys(frame, helloKeys, "hello frame");
  else if (frame.type === "syncChange") {
    rejectUnknownKeys(frame, syncChangeKeys, "sync change frame");
    requireCanonicalP256Signature(frame.deviceSignature, "deviceSignature");
  }
  return decodeClientWebSocketFrameSchema(frame);
}
export function decodeServerWebSocketFrame(input: unknown): ServerWebSocketFrame {
  const frame = record(input, "server websocket frame");
  if (frame.type === "helloAccepted")
    rejectUnknownKeys(frame, helloAcceptedKeys, "hello accepted frame");
  else if (frame.type === "syncAcknowledged")
    rejectUnknownKeys(frame, syncAcknowledgedKeys, "sync acknowledged frame");
  else if (frame.type === "error") {
    rejectUnknownKeys(frame, protocolErrorKeys, "protocol error frame");
    strictErrorBody(frame.error);
  }
  return decodeServerWebSocketFrameSchema(frame);
}

/**
 * The sole byte representation an enrolled-device signature covers. It is
 * binary length-prefixed by field order, not JSON, so JSON key order,
 * whitespace, and embedded line breaks cannot change what a signer verifies.
 */
export function syncChangeSigningPayload(frame: SyncChangeFrame): Uint8Array {
  return lengthPrefixedUTF8("ENCHSYNC", frame.signingPayloadVersion, [
    String(frame.protocolVersion),
    frame.vaultID,
    frame.deviceID,
    String(frame.authEpoch),
    frame.changeID,
    String(frame.causalVersion),
    frame.frameID,
    frame.payloadBase64,
  ]);
}

/** `magic` + u8 version + repeated u32-big-endian UTF-8 byte length + bytes. */
function lengthPrefixedUTF8(magic: string, version: number, fields: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const magicBytes = encoder.encode(magic);
  const encoded = fields.map((field) => encoder.encode(field));
  const length =
    magicBytes.length + 1 + encoded.reduce((total, field) => total + 4 + field.length, 0);
  const output = new Uint8Array(length);
  output.set(magicBytes);
  output[magicBytes.length] = version;
  const view = new DataView(output.buffer);
  let offset = magicBytes.length + 1;
  for (const field of encoded) {
    view.setUint32(offset, field.length, false);
    offset += 4;
    output.set(field, offset);
    offset += field.length;
  }
  return output;
}

export interface HttpOperation {
  readonly operationID: "registerDevice" | "revokeDevice";
  readonly method: "POST";
  readonly path: string;
  readonly requestSchema: "DeviceRegisterRequest" | "DeviceRevokeRequest";
  readonly successSchema: "DeviceRegisterResponse" | "DeviceRevokeResponse";
}

/** Language-neutral operation table; workers may bind routes later. */
export const httpOperations: readonly HttpOperation[] = [
  {
    operationID: "registerDevice",
    method: "POST",
    path: "/v2/devices/register",
    requestSchema: "DeviceRegisterRequest",
    successSchema: "DeviceRegisterResponse",
  },
  {
    operationID: "revokeDevice",
    method: "POST",
    path: "/v2/devices/{deviceId}/revoke",
    requestSchema: "DeviceRevokeRequest",
    successSchema: "DeviceRevokeResponse",
  },
];

export const websocketContract = {
  path: "/v2/sync",
  negotiationFailureCloseCode: 4426,
  httpNegotiationFailureStatus: 426,
  clientSchema: "ClientWebSocketFrame",
  serverSchema: "ServerWebSocketFrame",
  syncChangeProof: {
    signingPayloadVersion: syncFrameSigningPayloadVersion,
    algorithm: "p256-sha256-der",
    replayKey: "deviceID:frameID",
    canonicalBytes:
      "ASCII magic ENCHSYNC, u8 signingPayloadVersion, then u32-big-endian UTF-8 byte length and bytes for: protocolVersion, vaultID, deviceID, authEpoch, changeID, causalVersion, frameID, payloadBase64",
  },
} as const;
