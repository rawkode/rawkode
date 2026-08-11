import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

/** The single wire version emitted and accepted by this package. */
export const protocolVersion = 2 as const;
export const supportedProtocolVersions = [protocolVersion] as const;
export const syncFrameSigningPayloadVersion = 1 as const;

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TEXT_LENGTH = 512;
const MAX_PAYLOAD_BASE64_LENGTH = 1_398_104; // 1 MiB decoded payload.
const MAX_CANONICAL_PATH_LENGTH = 512;
const MAX_CANONICAL_QUERY_LENGTH = 1_024;
/** Opaque, server-issued resumptions are bounded before the raw frame reaches a DO. */
export const maximumResumeTokenLength = 512;
/**
 * Raw JSON enters the worker before schema validation, so bound the structural
 * pass independently of any individual protocol payload limit. The largest
 * current JSON field is the 1 MiB decoded/base64 payload.
 */
export const rawJSONStructuralLimits = {
  inputCodeUnits: 2 * 1024 * 1024,
  nestingDepth: 64,
  membersPerContainer: 128,
  stringCodeUnits: 1_500_000,
  numberCodeUnits: 64,
} as const;
export const signedRequestHeaderName = "Enchiridion-Signed-Request";
export const maximumSignedRequestHeaderLength = 8_192;
const SIGNED_TIMESTAMP_MINIMUM = 1_700_000_000_000;
const SIGNED_TIMESTAMP_MAXIMUM = 4_102_444_800_000;
const SIGNED_REQUEST_MINIMUM_TTL = 1_000;
const SIGNED_REQUEST_MAXIMUM_TTL = 300_000;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const p256DerBase64 = /^(?=M)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const opaqueIdentifier = /^[A-Za-z0-9._~-]+$/;
const frameID = /^[A-Za-z0-9_-]{22}$/;
const base64urlText = /^[A-Za-z0-9_-]+$/;
const sha256Digest = /^[0-9a-f]{64}$/;
const p256SPKIPrefix = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
/** secp256r1 group order and floor(n / 2), fixed-width big-endian scalars. */
const p256Order = Uint8Array.from([
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
]);
const p256HalfOrder = Uint8Array.from([
  0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
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

/** RFC 3986 component encoding with uppercase escapes and no `+` shorthand. */
export function percentEncodeRFC3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export type CanonicalQueryEntry = readonly [key: string, value: string];

/** Empty query is represented by the empty string; pairs sort by encoded key then value. */
export function canonicalizeQuery(entries: readonly CanonicalQueryEntry[]): string {
  const names = new Set<string>();
  for (const [name] of entries) {
    if (names.has(name))
      throw new TypeError("Canonical query names must be unique after decoding.");
    names.add(name);
  }
  return entries
    .map(([key, value]) => [percentEncodeRFC3986(key), percentEncodeRFC3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : leftKey < rightKey
          ? -1
          : 1,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** Rejects query aliases such as `+`, omitted values, malformed escapes, or unsorted pairs. */
export function canonicalizeQueryString(value: string): string | undefined {
  if (value === "") return "";
  if (value.startsWith("?") || value.includes("+")) return undefined;
  try {
    const entries: CanonicalQueryEntry[] = [];
    for (const part of value.split("&")) {
      const equals = part.indexOf("=");
      if (equals < 1 || part.indexOf("=", equals + 1) >= 0) return undefined;
      entries.push([
        decodeURIComponent(part.slice(0, equals)),
        decodeURIComponent(part.slice(equals + 1)),
      ]);
    }
    return canonicalizeQuery(entries) === value ? value : undefined;
  } catch {
    return undefined;
  }
}

const isUnreserved = (value: string): boolean =>
  (value >= "A" && value <= "Z") ||
  (value >= "a" && value <= "z") ||
  (value >= "0" && value <= "9") ||
  "-._~".includes(value);

const isUpperHex = (value: string): boolean =>
  (value >= "0" && value <= "9") || (value >= "A" && value <= "F");

/** Matches runtime: literal unreserved characters plus uppercase escapes only. */
export function canonicalizePath(value: string): string | undefined {
  if (!value.startsWith("/") || value.length > MAX_CANONICAL_PATH_LENGTH) return undefined;
  if (value === "/") return value;
  if (value.endsWith("/")) return undefined;
  for (const segment of value.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
    for (let index = 0; index < segment.length; index += 1) {
      const character = segment[index] ?? "";
      if (isUnreserved(character)) continue;
      if (
        character !== "%" ||
        !isUpperHex(segment[index + 1] ?? "") ||
        !isUpperHex(segment[index + 2] ?? "")
      )
        return undefined;
      const decoded = String.fromCharCode(Number.parseInt(segment.slice(index + 1, index + 3), 16));
      if (isUnreserved(decoded) || decoded === "/") return undefined;
      index += 2;
    }
  }
  return value;
}

export type CanonicalJSON =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJSON[]
  | { readonly [key: string]: CanonicalJSON };

/**
 * Canonical JSON profile: UTF-8, recursively UTF-16-code-unit sorted keys,
 * ECMAScript JSON string escaping, no whitespace, and finite JSON numbers.
 * Timestamps on the wire are integer epoch milliseconds, never JSON dates.
 */
export function canonicalJSONStringify(value: CanonicalJSON): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSONStringify).join(",")}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("Canonical JSON objects must be plain objects.");
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJSONStringify(child)}`)
    .join(",")}}`;
}

export function canonicalJSONBytes(value: CanonicalJSON): Uint8Array {
  return new TextEncoder().encode(canonicalJSONStringify(value));
}

/** Dependency-free SHA-256 keeps canonical body verification synchronous at every boundary. */
export function sha256Hex(bytes: Uint8Array): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const words = new Uint32Array(64);
  const byteAt = (values: Uint8Array, index: number): number => values[index] ?? 0;
  const wordAt = (index: number): number => words[index] ?? 0;
  const bits = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  let bitLength = bits;
  for (let index = 7; index >= 0; index -= 1) {
    padded[padded.length - 8 + index] = bitLength & 0xff;
    bitLength = Math.floor(bitLength / 256);
  }
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      words[index] =
        ((byteAt(padded, offset + index * 4) << 24) |
          (byteAt(padded, offset + index * 4 + 1) << 16) |
          (byteAt(padded, offset + index * 4 + 2) << 8) |
          byteAt(padded, offset + index * 4 + 3)) >>>
        0;
    for (let index = 16; index < 64; index += 1) {
      const a = wordAt(index - 15);
      const b = wordAt(index - 2);
      words[index] =
        (wordAt(index - 16) +
          ((a >>> 7) | (a << 25)) +
          ((a >>> 18) | (a << 14)) +
          (a >>> 3) +
          wordAt(index - 7) +
          ((b >>> 17) | (b << 15)) +
          ((b >>> 19) | (b << 13)) +
          (b >>> 10)) >>>
        0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + s1 + choice + (constants[index] ?? 0) + wordAt(index)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + s0 + majority) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

export function canonicalJSONSHA256(value: CanonicalJSON): string {
  return sha256Hex(canonicalJSONBytes(value));
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

function derPositiveInteger(
  bytes: Uint8Array,
  offset: number,
): readonly [Uint8Array, number] | undefined {
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
  const magnitude =
    first === 0 ? bytes.slice(contentOffset + 1, end) : bytes.slice(contentOffset, end);
  if (magnitude.length < 1 || magnitude.length > 32) return undefined;
  const scalar = new Uint8Array(32);
  scalar.set(magnitude, 32 - magnitude.length);
  return [scalar, end];
}

function compareBigEndian(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const isValidP256Scalar = (value: Uint8Array): boolean =>
  value.some((byte) => byte !== 0) && compareBigEndian(value, p256Order) < 0;

/**
 * Canonical P-256 ECDSA DER profile: positive, minimal R/S scalars in [1,n-1]
 * and `S <= floor(n/2)`. High-S twins are rejected rather than normalized so a
 * wire signature has exactly one accepted representation.
 */
export function isCanonicalP256LowSSignature(value: string): boolean {
  const bytes = canonicalBase64Bytes(value);
  if (bytes === undefined) return false;
  if (bytes[0] !== 0x30) return false;
  const sequence = derLength(bytes, 1);
  if (sequence === undefined) return false;
  const [size, contentOffset] = sequence;
  if (contentOffset + size !== bytes.length) return false;
  const r = derPositiveInteger(bytes, contentOffset);
  if (r === undefined || !isValidP256Scalar(r[0])) return false;
  const s = derPositiveInteger(bytes, r[1]);
  return (
    s !== undefined &&
    s[1] === bytes.length &&
    isValidP256Scalar(s[0]) &&
    compareBigEndian(s[0], p256HalfOrder) <= 0
  );
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
/** Server-owned, monotonically assigned position in an OwnerVault mutation log. */
export const LogSequenceSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  named("LogSequence"),
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
/** Canonical base64url opaque session continuation, never a bearer header value. */
export const ResumeTokenSchema = Schema.String.pipe(
  Schema.pattern(base64urlText),
  Schema.minLength(22),
  Schema.maxLength(maximumResumeTokenLength),
  Schema.filter((value) => fromBase64url(value) !== undefined),
  Schema.annotations({
    jsonSchema: {
      format: "base64url-canonical",
      minLength: 22,
      maxLength: maximumResumeTokenLength,
    },
  }),
  named("ResumeToken"),
);
export const ProtocolVersionSchema = Schema.Literal(protocolVersion).pipe(named("ProtocolVersion"));
export const SHA256DigestSchema = Schema.String.pipe(
  Schema.pattern(sha256Digest),
  Schema.annotations({ jsonSchema: { format: "sha256-hex", minLength: 64, maxLength: 64 } }),
  named("SHA256Digest"),
);
/** Canonical base64url wire value used by the fixed signed-request header. */
export const SignedRequestHeaderValueSchema = Schema.String.pipe(
  Schema.pattern(base64urlText),
  Schema.minLength(1),
  Schema.maxLength(maximumSignedRequestHeaderLength),
  Schema.filter((value) => fromBase64url(value) !== undefined),
  Schema.annotations({
    jsonSchema: {
      format: "base64url-canonical",
      minLength: 1,
      maxLength: maximumSignedRequestHeaderLength,
    },
  }),
  named("SignedRequestHeaderValue"),
);
export const CanonicalPathSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_CANONICAL_PATH_LENGTH),
  Schema.filter((value) => canonicalizePath(value) === value),
  Schema.annotations({
    jsonSchema: { format: "canonical-path", maxLength: MAX_CANONICAL_PATH_LENGTH },
  }),
  named("CanonicalPath"),
);
export const CanonicalQuerySchema = Schema.String.pipe(
  Schema.maxLength(MAX_CANONICAL_QUERY_LENGTH),
  Schema.filter((value) => canonicalizeQueryString(value) === value),
  Schema.annotations({
    jsonSchema: { format: "canonical-query", maxLength: MAX_CANONICAL_QUERY_LENGTH },
  }),
  named("CanonicalQuery"),
);
export const SignedTimestampSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(SIGNED_TIMESTAMP_MINIMUM),
  Schema.lessThanOrEqualTo(SIGNED_TIMESTAMP_MAXIMUM),
  named("SignedTimestamp"),
);
export const HTTPMethodSchema = Schema.Literal("POST", "PUT", "DELETE").pipe(named("HTTPMethod"));
export const AuthEpochSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  named("AuthEpoch"),
);
export const CredentialEpochSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  named("CredentialEpoch"),
);
export const GenerationEpochSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  named("GenerationEpoch"),
);
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
/** Canonical low-S P-256 ECDSA DER: unique positive R/S scalars, base64 encoded. */
export const P256SignatureBase64Schema = Schema.String.pipe(
  Schema.pattern(p256DerBase64),
  Schema.minLength(12),
  Schema.maxLength(96),
  Schema.filter(isCanonicalP256LowSSignature),
  Schema.annotations({
    jsonSchema: { format: "p256-ecdsa-der-low-s", maxLength: 96 },
  }),
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

/** Unauthenticated bootstrap request. It is the only device endpoint without a signed envelope. */
export const DeviceChallengeRequestSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  devicePublicKey: P256SPKIBase64Schema,
  challengeAudience: text(256),
}).pipe(named("DeviceChallengeRequest"));

export const DeviceChallengeResponseSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  challengeID: identifier("Identifier"),
  challengeBase64: Base64PayloadSchema,
  expiresAt: SignedTimestampSchema,
}).pipe(named("DeviceChallengeResponse"));

/** Full challenge binding signed by the new device during initial registration. */
export const DeviceChallengeProofSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  challengeID: identifier("Identifier"),
  challengeAudience: text(256),
  challengeBase64: Base64PayloadSchema,
  expiresAt: SignedTimestampSchema,
  nonce: FrameIDSchema,
  devicePublicKey: P256SPKIBase64Schema,
  signature: P256SignatureBase64Schema,
}).pipe(named("DeviceChallengeProof"));

export const DeviceRegisterRequestShapeSchema = Schema.Struct({
  challengeProof: DeviceChallengeProofSchema,
  idempotencyKey: identifier("Identifier"),
});
export const DeviceRegisterRequestSchema = DeviceRegisterRequestShapeSchema.pipe(
  named("DeviceRegisterRequest"),
);

export const DeviceRegisterResponseSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  ownerID: OwnerIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: AuthEpochSchema,
}).pipe(named("DeviceRegisterResponse"));

/**
 * Signature proof for every non-bootstrap request. The signature covers
 * `signedDeviceRequestSigningPayload(envelope)`, not a JSON serialization.
 * `canonicalQuery` is exactly `""` when the URL has no query string.
 */
export const SignedDeviceRequestEnvelopeSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  method: HTTPMethodSchema,
  canonicalPath: CanonicalPathSchema,
  canonicalQuery: CanonicalQuerySchema,
  bodySHA256: SHA256DigestSchema,
  requestID: identifier("Identifier"),
  idempotencyKey: identifier("Identifier"),
  ownerID: OwnerIDSchema,
  vaultID: VaultIDSchema,
  generationEpoch: GenerationEpochSchema,
  actorDeviceID: DeviceIDSchema,
  targetDeviceID: Schema.optional(DeviceIDSchema),
  authEpoch: AuthEpochSchema,
  credentialEpoch: CredentialEpochSchema,
  issuedAt: SignedTimestampSchema,
  expiresAt: SignedTimestampSchema,
  nonce: FrameIDSchema,
  deviceSignature: P256SignatureBase64Schema,
}).pipe(named("SignedDeviceRequestEnvelope"));

export const DeviceRevokeCommandSchema = Schema.Struct({
  type: Schema.Literal("deviceRevoke"),
  actorDeviceID: DeviceIDSchema,
  targetDeviceID: DeviceIDSchema,
}).pipe(named("DeviceRevokeCommand"));

export const DeviceRevokeRequestSchema = Schema.Struct({
  envelope: SignedDeviceRequestEnvelopeSchema,
  command: DeviceRevokeCommandSchema,
}).pipe(named("DeviceRevokeRequest"));

export const DeviceRevokeResponseSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  ownerID: OwnerIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: AuthEpochSchema,
  revokedAt: SignedTimestampSchema,
}).pipe(named("DeviceRevokeResponse"));

/** The ingress surface that carried an opaque logical operation. */
export const OpaqueMutationSourceKindSchema = Schema.Literal("http", "websocket").pipe(
  named("OpaqueMutationSourceKind"),
);

/**
 * Canonical JSON body for POST /v2/mutations. `operationID` is shared with
 * WebSocket sync: it is one vault-wide logical-operation namespace, never an
 * HTTP-only idempotency key. The payload digest is of decoded payload bytes.
 */
export const MutationCommandSchema = Schema.Struct({
  type: Schema.Literal("mutation"),
  operationID: identifier("Identifier"),
  deviceID: DeviceIDSchema,
  sourceKind: Schema.Literal("http"),
  payloadSHA256: SHA256DigestSchema,
  payloadBase64: Base64PayloadSchema,
  /** Client causal metadata only; never an authoritative server log position. */
  causalVersion: Schema.optional(nonNegativeInt),
}).pipe(named("MutationCommand"));

export const MutationRequestSchema = Schema.Struct({
  envelope: SignedDeviceRequestEnvelopeSchema,
  command: MutationCommandSchema,
}).pipe(named("MutationRequest"));

export const MutationResponseSchema = Schema.Struct({
  protocolVersion: ProtocolVersionSchema,
  operationID: identifier("Identifier"),
  /** Assigned by OwnerVault only after the operation and receipt commit. */
  logSequence: LogSequenceSchema,
}).pipe(named("MutationResponse"));

export const BlobOperationTypeSchema = Schema.Literal("blobPut", "blobDelete").pipe(
  named("BlobOperationType"),
);

/**
 * Content-addressed binary operation metadata. It is not a JSON request body:
 * for PUT, the envelope body hash is SHA-256 of the exact octets sent and must
 * equal both this path digest and `blobSHA256`. DELETE has the empty-body hash.
 */
export const ContentAddressedBlobOperationSchema = Schema.Struct({
  type: BlobOperationTypeSchema,
  blobSHA256: SHA256DigestSchema,
  contentLength: Schema.optional(nonNegativeInt),
}).pipe(named("ContentAddressedBlobOperation"));

/** Canonical JSON no-body semantic command for DELETE /v2/blobs/{sha256}. */
export const BlobDeleteCommandSchema = Schema.Struct({
  type: Schema.Literal("blobDelete"),
  blobSHA256: SHA256DigestSchema,
}).pipe(named("BlobDeleteCommand"));
export const BlobDeleteRequestSchema = Schema.Struct({
  envelope: SignedDeviceRequestEnvelopeSchema,
  command: BlobDeleteCommandSchema,
}).pipe(named("BlobDeleteRequest"));

/**
 * The first server frame immediately after a successful WebSocket upgrade.
 * The connection nonce is CSPRNG-issued by the Worker; this schema preserves
 * its canonical 128-bit wire representation and binds all server selection.
 */
export const ServerHelloChallengeFrameSchema = Schema.Struct({
  type: Schema.Literal("serverHelloChallenge"),
  protocolVersion: ProtocolVersionSchema,
  connectionNonce: FrameIDSchema,
  issuedAt: SignedTimestampSchema,
  expiresAt: SignedTimestampSchema,
  ownerID: OwnerIDSchema,
  vaultID: VaultIDSchema,
  authEpoch: AuthEpochSchema,
  credentialEpoch: CredentialEpochSchema,
  generationEpoch: GenerationEpochSchema,
}).pipe(named("ServerHelloChallengeFrame"));

/** First client frame, signed against the immediately preceding server challenge. */
export const HelloFrameSchema = Schema.Struct({
  type: Schema.Literal("hello"),
  protocolVersion: ProtocolVersionSchema,
  connectionNonce: FrameIDSchema,
  resumeToken: Schema.optional(ResumeTokenSchema),
  deviceID: DeviceIDSchema,
  authEpoch: AuthEpochSchema,
  /** Low-S P-256 DER signature of `helloSigningPayload(frame, challenge)`. */
  deviceSignature: P256SignatureBase64Schema,
}).pipe(named("HelloFrame"));

export const HelloAcceptedFrameSchema = Schema.Struct({
  type: Schema.Literal("helloAccepted"),
  protocolVersion: ProtocolVersionSchema,
  ownerID: OwnerIDSchema,
  vaultID: VaultIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: AuthEpochSchema,
  credentialEpoch: CredentialEpochSchema,
  generationEpoch: GenerationEpochSchema,
  sessionNonce: FrameIDSchema,
  /** Rotated, opaque continuation token. It is never supplied in an HTTP header. */
  resumeToken: ResumeTokenSchema,
  assertionExpiresAt: SignedTimestampSchema,
}).pipe(named("HelloAcceptedFrame"));

export const SyncChangeFrameSchema = Schema.Struct({
  type: Schema.Literal("syncChange"),
  protocolVersion: ProtocolVersionSchema,
  vaultID: VaultIDSchema,
  deviceID: DeviceIDSchema,
  authEpoch: AuthEpochSchema,
  credentialEpoch: CredentialEpochSchema,
  generationEpoch: GenerationEpochSchema,
  sessionNonce: FrameIDSchema,
  assertionExpiresAt: SignedTimestampSchema,
  /** Same vault-wide logical-operation namespace as HTTP MutationCommand. */
  operationID: identifier("Identifier"),
  sourceKind: Schema.Literal("websocket"),
  payloadSHA256: SHA256DigestSchema,
  /** Client causal metadata only; never an authoritative server log position. */
  causalVersion: Schema.optional(nonNegativeInt),
  /**
   * The sender's last durably observed OwnerVault log sequence. OwnerVault
   * rejects a value ahead of its authoritative head inside the mutation
   * transaction; this is client evidence, never a requested log position.
   */
  observedHighWater: nonNegativeInt,
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
  operationID: identifier("Identifier"),
  /** Assigned by OwnerVault only after the operation and receipt commit. */
  logSequence: LogSequenceSchema,
}).pipe(named("SyncAcknowledgedFrame"));

export const ProtocolErrorFrameSchema = Schema.Struct({
  type: Schema.Literal("error"),
  protocolVersion: ProtocolVersionSchema,
  error: ErrorBodySchema,
}).pipe(named("ProtocolErrorFrame"));

export const ClientWebSocketFrameSchema = Schema.Union(HelloFrameSchema, SyncChangeFrameSchema);
export const ServerWebSocketFrameSchema = Schema.Union(
  ServerHelloChallengeFrameSchema,
  HelloAcceptedFrameSchema,
  SyncAcknowledgedFrameSchema,
  ProtocolErrorFrameSchema,
);

/** The sole public model registry. Artifact and Swift generation consume it. */
export const protocolSchemaDefinitions = {
  ErrorBody: ErrorBodySchema,
  ErrorEnvelope: ErrorEnvelopeSchema,
  DeviceChallengeRequest: DeviceChallengeRequestSchema,
  DeviceChallengeResponse: DeviceChallengeResponseSchema,
  DeviceChallengeProof: DeviceChallengeProofSchema,
  DeviceRegisterRequest: DeviceRegisterRequestSchema,
  DeviceRegisterResponse: DeviceRegisterResponseSchema,
  SignedDeviceRequestEnvelope: SignedDeviceRequestEnvelopeSchema,
  DeviceRevokeCommand: DeviceRevokeCommandSchema,
  DeviceRevokeRequest: DeviceRevokeRequestSchema,
  DeviceRevokeResponse: DeviceRevokeResponseSchema,
  MutationCommand: MutationCommandSchema,
  MutationRequest: MutationRequestSchema,
  MutationResponse: MutationResponseSchema,
  ContentAddressedBlobOperation: ContentAddressedBlobOperationSchema,
  BlobDeleteCommand: BlobDeleteCommandSchema,
  BlobDeleteRequest: BlobDeleteRequestSchema,
  ServerHelloChallengeFrame: ServerHelloChallengeFrameSchema,
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
export type DeviceChallengeRequest = Schema.Schema.Type<typeof DeviceChallengeRequestSchema>;
export type DeviceChallengeResponse = Schema.Schema.Type<typeof DeviceChallengeResponseSchema>;
export type DeviceRegisterRequest = Schema.Schema.Type<typeof DeviceRegisterRequestSchema>;
export type DeviceRegisterResponse = Schema.Schema.Type<typeof DeviceRegisterResponseSchema>;
export type DeviceRevokeRequest = Schema.Schema.Type<typeof DeviceRevokeRequestSchema>;
export type DeviceRevokeResponse = Schema.Schema.Type<typeof DeviceRevokeResponseSchema>;
export type SignedDeviceRequestEnvelope = Schema.Schema.Type<
  typeof SignedDeviceRequestEnvelopeSchema
>;
export type DeviceRevokeCommand = Schema.Schema.Type<typeof DeviceRevokeCommandSchema>;
export type MutationCommand = Schema.Schema.Type<typeof MutationCommandSchema>;
export type MutationRequest = Schema.Schema.Type<typeof MutationRequestSchema>;
export type MutationResponse = Schema.Schema.Type<typeof MutationResponseSchema>;
export type OpaqueMutationSourceKind = Schema.Schema.Type<typeof OpaqueMutationSourceKindSchema>;
export type ContentAddressedBlobOperation = Schema.Schema.Type<
  typeof ContentAddressedBlobOperationSchema
>;
export type BlobDeleteCommand = Schema.Schema.Type<typeof BlobDeleteCommandSchema>;
export type BlobDeleteRequest = Schema.Schema.Type<typeof BlobDeleteRequestSchema>;
export type ServerHelloChallengeFrame = Schema.Schema.Type<typeof ServerHelloChallengeFrameSchema>;
export type ClientWebSocketFrame = Schema.Schema.Type<typeof ClientWebSocketFrameSchema>;
export type ServerWebSocketFrame = Schema.Schema.Type<typeof ServerWebSocketFrameSchema>;
export type SyncChangeFrame = Schema.Schema.Type<typeof SyncChangeFrameSchema>;

const decodeErrorEnvelopeSchema = Schema.decodeUnknownSync(ErrorEnvelopeSchema);
const decodeDeviceChallengeRequestSchema = Schema.decodeUnknownSync(DeviceChallengeRequestSchema);
const decodeDeviceChallengeResponseSchema = Schema.decodeUnknownSync(DeviceChallengeResponseSchema);
const decodeDeviceRegisterRequestSchema = Schema.decodeUnknownSync(DeviceRegisterRequestSchema);
const decodeDeviceRegisterResponseSchema = Schema.decodeUnknownSync(DeviceRegisterResponseSchema);
const decodeDeviceRevokeRequestSchema = Schema.decodeUnknownSync(DeviceRevokeRequestSchema);
const decodeDeviceRevokeResponseSchema = Schema.decodeUnknownSync(DeviceRevokeResponseSchema);
const decodeMutationRequestSchema = Schema.decodeUnknownSync(MutationRequestSchema);
const decodeContentAddressedBlobOperationSchema = Schema.decodeUnknownSync(
  ContentAddressedBlobOperationSchema,
);
const decodeBlobDeleteRequestSchema = Schema.decodeUnknownSync(BlobDeleteRequestSchema);
const decodeClientWebSocketFrameSchema = Schema.decodeUnknownSync(ClientWebSocketFrameSchema);
const decodeServerWebSocketFrameSchema = Schema.decodeUnknownSync(ServerWebSocketFrameSchema);

const errorBodyKeys = ["code", "message", "retryable", "requestID", "supportedProtocolVersions"];
const errorEnvelopeKeys = ["protocolVersion", "error"];
const challengeRequestKeys = ["protocolVersion", "devicePublicKey", "challengeAudience"];
const challengeResponseKeys = ["protocolVersion", "challengeID", "challengeBase64", "expiresAt"];
const registerRequestKeys = ["challengeProof", "idempotencyKey"];
const challengeProofKeys = [
  "protocolVersion",
  "challengeID",
  "challengeAudience",
  "challengeBase64",
  "expiresAt",
  "nonce",
  "devicePublicKey",
  "signature",
];
const registerResponseKeys = ["protocolVersion", "ownerID", "deviceID", "authEpoch"];
const signedEnvelopeKeys = [
  "protocolVersion",
  "method",
  "canonicalPath",
  "canonicalQuery",
  "bodySHA256",
  "requestID",
  "idempotencyKey",
  "ownerID",
  "vaultID",
  "generationEpoch",
  "actorDeviceID",
  "targetDeviceID",
  "authEpoch",
  "credentialEpoch",
  "issuedAt",
  "expiresAt",
  "nonce",
  "deviceSignature",
];
const revokeCommandKeys = ["type", "actorDeviceID", "targetDeviceID"];
const revokeRequestKeys = ["envelope", "command"];
const revokeResponseKeys = ["protocolVersion", "ownerID", "deviceID", "authEpoch", "revokedAt"];
const mutationCommandKeys = [
  "type",
  "operationID",
  "deviceID",
  "sourceKind",
  "payloadSHA256",
  "payloadBase64",
  "causalVersion",
];
const mutationRequestKeys = ["envelope", "command"];
const blobOperationKeys = ["type", "blobSHA256", "contentLength"];
const blobDeleteCommandKeys = ["type", "blobSHA256"];
const blobDeleteRequestKeys = ["envelope", "command"];
const serverHelloChallengeKeys = [
  "type",
  "protocolVersion",
  "connectionNonce",
  "issuedAt",
  "expiresAt",
  "ownerID",
  "vaultID",
  "authEpoch",
  "credentialEpoch",
  "generationEpoch",
];
const helloKeys = [
  "type",
  "protocolVersion",
  "connectionNonce",
  "resumeToken",
  "deviceID",
  "authEpoch",
  "deviceSignature",
];
const helloAcceptedKeys = [
  "type",
  "protocolVersion",
  "ownerID",
  "vaultID",
  "deviceID",
  "authEpoch",
  "credentialEpoch",
  "generationEpoch",
  "sessionNonce",
  "resumeToken",
  "assertionExpiresAt",
];
const syncChangeKeys = [
  "type",
  "protocolVersion",
  "vaultID",
  "deviceID",
  "authEpoch",
  "credentialEpoch",
  "generationEpoch",
  "sessionNonce",
  "assertionExpiresAt",
  "operationID",
  "sourceKind",
  "payloadSHA256",
  "causalVersion",
  "observedHighWater",
  "frameID",
  "signingPayloadVersion",
  "payloadBase64",
  "deviceSignature",
];
const syncAcknowledgedKeys = ["type", "protocolVersion", "vaultID", "operationID", "logSequence"];
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
  if (typeof value !== "string" || !isCanonicalP256LowSSignature(value))
    throw new TypeError(`${name} must be canonical low-S P-256 ECDSA DER base64.`);
}

function requireCanonicalP256SPKI(value: unknown, name: string): void {
  if (typeof value !== "string" || !isCanonicalP256SPKI(value))
    throw new TypeError(`${name} must be canonical P-256 SPKI DER base64.`);
}

function strictSignedEnvelope(value: unknown): Record<string, unknown> {
  const envelope = rejectUnknownKeys(value, signedEnvelopeKeys, "signed device request envelope");
  requireCanonicalP256Signature(envelope.deviceSignature, "deviceSignature");
  const issuedAt = envelope.issuedAt;
  const expiresAt = envelope.expiresAt;
  if (
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number" ||
    expiresAt - issuedAt < SIGNED_REQUEST_MINIMUM_TTL ||
    expiresAt - issuedAt > SIGNED_REQUEST_MAXIMUM_TTL
  )
    throw new TypeError(
      "Signed request expiry must be between 1 second and 5 minutes after issuance.",
    );
  return envelope;
}

export function validateSignedDeviceRequestEnvelope(input: unknown): SignedDeviceRequestEnvelope {
  return Schema.decodeUnknownSync(SignedDeviceRequestEnvelopeSchema)(strictSignedEnvelope(input));
}

/**
 * Parses JSON structurally before schema decoding and rejects duplicate object
 * members at every nesting depth. This is a single forward lexical pass: its
 * limits make hostile deeply-nested, huge-string, or huge-number input fail
 * before `JSON.parse` builds a value. JSON.parse alone loses duplicate members.
 */
export function parseJSONWithoutDuplicateMembers(source: string): unknown {
  if (source.length > rawJSONStructuralLimits.inputCodeUnits)
    throw new TypeError("JSON input exceeds the structural limit.");

  let offset = 0;
  const whitespace = (): void => {
    while (true) {
      const character = source[offset];
      if (character !== " " && character !== "\n" && character !== "\r" && character !== "\t")
        return;
      offset += 1;
    }
  };
  const rejectLoneUTF16Surrogates = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new TypeError("JSON strings must not contain lone UTF-16 surrogates.");
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)
        throw new TypeError("JSON strings must not contain lone UTF-16 surrogates.");
    }
  };
  const string = (): string => {
    const start = offset;
    if (source[offset] !== '"') throw new TypeError("Expected JSON string.");
    offset += 1;
    while (offset < source.length) {
      const character = source[offset] ?? "";
      if (character === '"') {
        offset += 1;
        const decoded: unknown = JSON.parse(source.slice(start, offset));
        if (typeof decoded !== "string") throw new TypeError("Expected JSON string.");
        rejectLoneUTF16Surrogates(decoded);
        return decoded;
      }
      if (character === "\\") {
        offset += 1;
        const escapeCode = source[offset] ?? "";
        if (
          escapeCode !== '"' &&
          escapeCode !== "\\" &&
          escapeCode !== "/" &&
          escapeCode !== "b" &&
          escapeCode !== "f" &&
          escapeCode !== "n" &&
          escapeCode !== "r" &&
          escapeCode !== "t" &&
          escapeCode !== "u"
        )
          throw new TypeError("Invalid JSON escape.");
        if (escapeCode === "u") {
          for (let index = 1; index <= 4; index += 1) {
            const codeUnit = source[offset + index] ?? "";
            if (
              !(
                (codeUnit >= "0" && codeUnit <= "9") ||
                (codeUnit >= "a" && codeUnit <= "f") ||
                (codeUnit >= "A" && codeUnit <= "F")
              )
            )
              throw new TypeError("Invalid JSON unicode escape.");
          }
          offset += 4;
        }
      } else if (character.charCodeAt(0) < 0x20)
        throw new TypeError("Invalid JSON control character.");
      offset += 1;
      if (offset - start > rawJSONStructuralLimits.stringCodeUnits)
        throw new TypeError("JSON string exceeds the structural limit.");
    }
    throw new TypeError("Unterminated JSON string.");
  };
  const number = (): void => {
    const numberStart = offset;
    const advance = (): void => {
      offset += 1;
      if (offset - numberStart > rawJSONStructuralLimits.numberCodeUnits)
        throw new TypeError("JSON number exceeds the structural limit.");
    };
    const digit = (): boolean => {
      const character = source[offset] ?? "";
      return character >= "0" && character <= "9";
    };
    if (source[offset] === "-") advance();
    const firstDigit = source[offset] ?? "";
    if (firstDigit === "0") advance();
    else if (firstDigit >= "1" && firstDigit <= "9") {
      advance();
      while (digit()) advance();
    }
    if (offset > numberStart && source[offset] === ".") {
      advance();
      const decimalStart = offset;
      while (digit()) advance();
      if (offset === decimalStart) throw new TypeError("Invalid JSON number.");
    }
    if (offset > numberStart && (source[offset] === "e" || source[offset] === "E")) {
      advance();
      if (source[offset] === "+" || source[offset] === "-") advance();
      const exponentStart = offset;
      while (digit()) advance();
      if (offset === exponentStart) throw new TypeError("Invalid JSON exponent.");
    }
    if (offset === numberStart) throw new TypeError("Invalid JSON number.");
  };
  const value = (depth: number): void => {
    whitespace();
    const character = source[offset] ?? "";
    if (character === '"') {
      string();
      return;
    }
    if (character === "{") {
      if (depth >= rawJSONStructuralLimits.nestingDepth)
        throw new TypeError("JSON nesting exceeds the structural limit.");
      offset += 1;
      whitespace();
      const names = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      while (true) {
        if (names.size >= rawJSONStructuralLimits.membersPerContainer)
          throw new TypeError("JSON object members exceed the structural limit.");
        whitespace();
        const name = string();
        if (names.has(name)) throw new TypeError(`Duplicate JSON member ${name}.`);
        names.add(name);
        whitespace();
        if (source[offset] !== ":") throw new TypeError("Expected JSON colon.");
        offset += 1;
        value(depth + 1);
        whitespace();
        if (source[offset] === "}") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") throw new TypeError("Expected JSON object separator.");
        offset += 1;
      }
    }
    if (character === "[") {
      if (depth >= rawJSONStructuralLimits.nestingDepth)
        throw new TypeError("JSON nesting exceeds the structural limit.");
      offset += 1;
      whitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      let members = 0;
      while (true) {
        if (members >= rawJSONStructuralLimits.membersPerContainer)
          throw new TypeError("JSON array members exceed the structural limit.");
        members += 1;
        value(depth + 1);
        whitespace();
        if (source[offset] === "]") {
          offset += 1;
          return;
        }
        if (source[offset] !== ",") throw new TypeError("Expected JSON array separator.");
        offset += 1;
      }
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      number();
      return;
    }
    for (const literal of ["true", "false", "null"])
      if (source.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    throw new TypeError("Invalid JSON value.");
  };
  value(0);
  whitespace();
  if (offset !== source.length) throw new TypeError("Unexpected JSON trailing data.");
  return JSON.parse(source);
}

/** Worker-facing raw HTTP JSON ingress for signed revoke requests. */
export function decodeDeviceRevokeRequestJSON(source: string): DeviceRevokeRequest {
  return decodeDeviceRevokeRequest(parseJSONWithoutDuplicateMembers(source));
}
/** Worker-facing raw HTTP JSON ingress for `POST /v2/devices/challenge`. */
export function decodeDeviceChallengeRequestJSON(source: string): DeviceChallengeRequest {
  return decodeDeviceChallengeRequest(parseJSONWithoutDuplicateMembers(source));
}
/** Worker-facing raw HTTP JSON ingress for `POST /v2/devices/register`. */
export function decodeDeviceRegisterRequestJSON(source: string): DeviceRegisterRequest {
  return decodeDeviceRegisterRequest(parseJSONWithoutDuplicateMembers(source));
}
/** Worker-facing raw HTTP JSON ingress for signed mutation requests. */
export function decodeMutationRequestJSON(source: string): MutationRequest {
  return decodeMutationRequest(parseJSONWithoutDuplicateMembers(source));
}
/** Worker-facing raw HTTP JSON ingress for canonical no-body blob DELETE commands. */
export function decodeBlobDeleteRequestJSON(source: string): BlobDeleteRequest {
  return decodeBlobDeleteRequest(parseJSONWithoutDuplicateMembers(source));
}
export function decodeClientWebSocketFrameJSON(source: string): ClientWebSocketFrame {
  return decodeClientWebSocketFrame(parseJSONWithoutDuplicateMembers(source));
}
export function decodeServerWebSocketFrameJSON(source: string): ServerWebSocketFrame {
  return decodeServerWebSocketFrame(parseJSONWithoutDuplicateMembers(source));
}

export function decodeErrorEnvelope(input: unknown): ErrorEnvelope {
  const envelope = rejectUnknownKeys(input, errorEnvelopeKeys, "error envelope");
  strictErrorBody(envelope.error);
  return decodeErrorEnvelopeSchema(envelope);
}
export function decodeDeviceRegisterRequest(input: unknown): DeviceRegisterRequest {
  const request = rejectUnknownKeys(input, registerRequestKeys, "device register request");
  const proof = rejectUnknownKeys(
    request.challengeProof,
    challengeProofKeys,
    "device challenge proof",
  );
  requireCanonicalP256Signature(proof.signature, "challengeProof.signature");
  requireCanonicalP256SPKI(proof.devicePublicKey, "challengeProof.devicePublicKey");
  return decodeDeviceRegisterRequestSchema(request);
}
export function decodeDeviceChallengeRequest(input: unknown): DeviceChallengeRequest {
  const request = rejectUnknownKeys(input, challengeRequestKeys, "device challenge request");
  requireCanonicalP256SPKI(request.devicePublicKey, "devicePublicKey");
  return decodeDeviceChallengeRequestSchema(request);
}
export function decodeDeviceChallengeResponse(input: unknown): DeviceChallengeResponse {
  return decodeDeviceChallengeResponseSchema(
    rejectUnknownKeys(input, challengeResponseKeys, "device challenge response"),
  );
}
export function decodeDeviceRegisterResponse(input: unknown): DeviceRegisterResponse {
  return decodeDeviceRegisterResponseSchema(
    rejectUnknownKeys(input, registerResponseKeys, "device register response"),
  );
}
export function decodeDeviceRevokeRequest(input: unknown): DeviceRevokeRequest {
  const request = rejectUnknownKeys(input, revokeRequestKeys, "device revoke request");
  const envelope = strictSignedEnvelope(request.envelope);
  const command = rejectUnknownKeys(request.command, revokeCommandKeys, "device revoke command");
  if (
    envelope.actorDeviceID !== command.actorDeviceID ||
    envelope.targetDeviceID !== command.targetDeviceID
  )
    throw new TypeError("Signed revoke actor and target must match its envelope.");
  const decoded = decodeDeviceRevokeRequestSchema({ envelope, command });
  if (decoded.envelope.bodySHA256 !== deviceRevokeCommandSHA256(decoded.command))
    throw new TypeError("Signed revoke envelope body hash must match its canonical command only.");
  return decoded;
}
export function decodeDeviceRevokeResponse(input: unknown): DeviceRevokeResponse {
  return decodeDeviceRevokeResponseSchema(
    rejectUnknownKeys(input, revokeResponseKeys, "device revoke response"),
  );
}
export function decodeMutationRequest(input: unknown): MutationRequest {
  const request = rejectUnknownKeys(input, mutationRequestKeys, "mutation request");
  const envelope = strictSignedEnvelope(request.envelope);
  const command = rejectUnknownKeys(request.command, mutationCommandKeys, "mutation command");
  if (envelope.method !== "POST" || envelope.canonicalPath !== "/v2/mutations")
    throw new TypeError("Mutation envelope must bind POST /v2/mutations.");
  const decoded = decodeMutationRequestSchema({ envelope, command });
  if (decoded.command.deviceID !== decoded.envelope.actorDeviceID)
    throw new TypeError("Mutation command device must match its signed envelope actor.");
  assertOpaqueMutationPayload(decoded.command);
  if (decoded.envelope.bodySHA256 !== mutationCommandSHA256(decoded.command))
    throw new TypeError("Mutation envelope body hash must match its canonical command only.");
  return decoded;
}
export function decodeContentAddressedBlobOperation(input: unknown): ContentAddressedBlobOperation {
  return decodeContentAddressedBlobOperationSchema(
    rejectUnknownKeys(input, blobOperationKeys, "content-addressed blob operation"),
  );
}
export function decodeBlobDeleteRequest(input: unknown): BlobDeleteRequest {
  const request = rejectUnknownKeys(input, blobDeleteRequestKeys, "blob delete request");
  const envelope = strictSignedEnvelope(request.envelope);
  const command = rejectUnknownKeys(request.command, blobDeleteCommandKeys, "blob delete command");
  const decoded = decodeBlobDeleteRequestSchema({ envelope, command });
  if (
    decoded.envelope.method !== "DELETE" ||
    decoded.envelope.canonicalPath !== `/v2/blobs/${decoded.command.blobSHA256}` ||
    decoded.envelope.bodySHA256 !== blobDeleteCommandSHA256(decoded.command)
  )
    throw new TypeError("Blob delete envelope must bind its canonical delete command.");
  return decoded;
}
export function decodeClientWebSocketFrame(input: unknown): ClientWebSocketFrame {
  const frame = record(input, "client websocket frame");
  if (frame.type === "hello") {
    rejectUnknownKeys(frame, helloKeys, "hello frame");
    requireCanonicalP256Signature(frame.deviceSignature, "deviceSignature");
  } else if (frame.type === "syncChange") {
    rejectUnknownKeys(frame, syncChangeKeys, "sync change frame");
    requireCanonicalP256Signature(frame.deviceSignature, "deviceSignature");
  }
  const decoded = decodeClientWebSocketFrameSchema(frame);
  if (decoded.type === "syncChange") assertOpaqueMutationPayload(decoded);
  return decoded;
}

/**
 * Shared server-challenge policy. Raw decoding validates the bounded issuance
 * window; a signing caller must additionally supply its deterministic clock so
 * an already-expired challenge cannot be signed.
 */
export function validateServerHelloChallenge(
  challenge: ServerHelloChallengeFrame,
  nowMilliseconds?: number,
): void {
  const lifetime = challenge.expiresAt - challenge.issuedAt;
  if (lifetime < SIGNED_REQUEST_MINIMUM_TTL || lifetime > SIGNED_REQUEST_MAXIMUM_TTL)
    throw new TypeError("Server hello challenge expiry must be between 1,000 and 300,000ms.");
  if (nowMilliseconds !== undefined) {
    if (!Number.isSafeInteger(nowMilliseconds))
      throw new TypeError("Hello challenge clock must be a finite safe integer.");
    if (challenge.expiresAt <= nowMilliseconds)
      throw new TypeError("Server hello challenge has expired.");
  }
}

export function decodeServerWebSocketFrame(input: unknown): ServerWebSocketFrame {
  const frame = record(input, "server websocket frame");
  if (frame.type === "serverHelloChallenge")
    rejectUnknownKeys(frame, serverHelloChallengeKeys, "server hello challenge frame");
  else if (frame.type === "helloAccepted")
    rejectUnknownKeys(frame, helloAcceptedKeys, "hello accepted frame");
  else if (frame.type === "syncAcknowledged")
    rejectUnknownKeys(frame, syncAcknowledgedKeys, "sync acknowledged frame");
  else if (frame.type === "error") {
    rejectUnknownKeys(frame, protocolErrorKeys, "protocol error frame");
    strictErrorBody(frame.error);
  }
  const decoded = decodeServerWebSocketFrameSchema(frame);
  if (decoded.type === "serverHelloChallenge") validateServerHelloChallenge(decoded);
  return decoded;
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
    String(frame.credentialEpoch),
    String(frame.generationEpoch),
    frame.sessionNonce,
    String(frame.assertionExpiresAt),
    frame.operationID,
    frame.sourceKind,
    frame.payloadSHA256,
    frame.causalVersion === undefined ? "" : String(frame.causalVersion),
    String(frame.observedHighWater),
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

export type DeviceChallengeProof = Schema.Schema.Type<typeof DeviceChallengeProofSchema>;

/** Versioned, length-prefixed proof that binds the issued challenge to its SPKI. */
export function deviceChallengeProofSigningPayload(proof: DeviceChallengeProof): Uint8Array {
  return lengthPrefixedUTF8("ENCHCHAL", 1, [
    String(proof.protocolVersion),
    proof.challengeID,
    proof.challengeAudience,
    proof.challengeBase64,
    String(proof.expiresAt),
    proof.nonce,
    proof.devicePublicKey,
  ]);
}

export function helloSigningPayload(
  frame: Schema.Schema.Type<typeof HelloFrameSchema>,
  challenge: ServerHelloChallengeFrame,
  nowMilliseconds: number,
): Uint8Array {
  if (
    frame.protocolVersion !== challenge.protocolVersion ||
    frame.connectionNonce !== challenge.connectionNonce
  )
    throw new TypeError("Hello must echo the exact server challenge version and nonce.");
  validateServerHelloChallenge(challenge, nowMilliseconds);
  return lengthPrefixedUTF8("ENCHWSHELLO", 1, [
    frame.type,
    String(challenge.protocolVersion),
    challenge.connectionNonce,
    String(challenge.issuedAt),
    String(challenge.expiresAt),
    challenge.ownerID,
    challenge.vaultID,
    String(challenge.authEpoch),
    String(challenge.credentialEpoch),
    String(challenge.generationEpoch),
    String(frame.protocolVersion),
    frame.connectionNonce,
    frame.resumeToken ?? "null",
    frame.deviceID,
    String(frame.authEpoch),
  ]);
}

function revokeCommandJSON(command: DeviceRevokeCommand): CanonicalJSON {
  return {
    type: command.type,
    actorDeviceID: command.actorDeviceID,
    targetDeviceID: command.targetDeviceID,
  };
}

function mutationCommandJSON(command: MutationCommand): CanonicalJSON {
  const base: CanonicalJSON & Record<string, CanonicalJSON> = {
    type: command.type,
    operationID: command.operationID,
    deviceID: command.deviceID,
    sourceKind: command.sourceKind,
    payloadSHA256: command.payloadSHA256,
    payloadBase64: command.payloadBase64,
  };
  if (command.causalVersion !== undefined) base.causalVersion = command.causalVersion;
  return base;
}

type OpaqueMutationPayload = Pick<
  MutationCommand | SyncChangeFrame,
  "payloadBase64" | "payloadSHA256"
>;

/** Rejects a digest spelling that does not name the exact canonical payload bytes. */
function assertOpaqueMutationPayload(operation: OpaqueMutationPayload): void {
  const payload = canonicalBase64Bytes(operation.payloadBase64);
  if (payload === undefined || sha256Hex(payload) !== operation.payloadSHA256)
    throw new TypeError("Opaque mutation payload digest must match its canonical payload bytes.");
}

/** Body hashes bind only commands, never their enclosing signature envelope. */
export function deviceRevokeCommandSHA256(command: DeviceRevokeCommand): string {
  return canonicalJSONSHA256(revokeCommandJSON(command));
}

export function mutationCommandSHA256(command: MutationCommand): string {
  return canonicalJSONSHA256(mutationCommandJSON(command));
}
export function blobDeleteCommandSHA256(command: BlobDeleteCommand): string {
  return canonicalJSONSHA256({ type: command.type, blobSHA256: command.blobSHA256 });
}

/** Vector-backed canonical bytes for `SignedDeviceRequestEnvelope.deviceSignature`. */
export function signedDeviceRequestSigningPayload(
  envelope: SignedDeviceRequestEnvelope,
): Uint8Array {
  return lengthPrefixedUTF8("ENCHHTTP", protocolVersion, [
    String(envelope.protocolVersion),
    envelope.method,
    envelope.canonicalPath,
    envelope.canonicalQuery,
    envelope.bodySHA256,
    envelope.requestID,
    envelope.idempotencyKey,
    envelope.ownerID,
    envelope.vaultID,
    String(envelope.generationEpoch),
    envelope.actorDeviceID,
    envelope.targetDeviceID ?? "",
    String(envelope.authEpoch),
    String(envelope.credentialEpoch),
    String(envelope.issuedAt),
    String(envelope.expiresAt),
    envelope.nonce,
  ]);
}

export function envelopeMatchesCanonicalJSON(
  envelope: SignedDeviceRequestEnvelope,
  body: CanonicalJSON,
): boolean {
  return canonicalJSONSHA256(body) === envelope.bodySHA256;
}

/** The raw PUT bytes, rather than JSON operation metadata, are signature-bound. */
export function envelopeMatchesBlobBytes(
  envelope: SignedDeviceRequestEnvelope,
  blobSHA256: string,
  bytes: Uint8Array,
): boolean {
  const digest = sha256Hex(bytes);
  return (
    envelope.method === "PUT" &&
    envelope.canonicalPath === `/v2/blobs/${blobSHA256}` &&
    digest === blobSHA256 &&
    envelope.bodySHA256 === digest
  );
}

export interface ProtocolHeader {
  readonly name: string;
  readonly value: string;
}

function base64url(bytes: Uint8Array): string {
  return encodedBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | undefined {
  if (!base64urlText.test(value)) return undefined;
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const bytes = canonicalBase64Bytes(padded);
  return bytes !== undefined && base64url(bytes) === value ? bytes : undefined;
}

function signedEnvelopeJSON(envelope: SignedDeviceRequestEnvelope): CanonicalJSON {
  return {
    protocolVersion: envelope.protocolVersion,
    method: envelope.method,
    canonicalPath: envelope.canonicalPath,
    canonicalQuery: envelope.canonicalQuery,
    bodySHA256: envelope.bodySHA256,
    requestID: envelope.requestID,
    idempotencyKey: envelope.idempotencyKey,
    ownerID: envelope.ownerID,
    vaultID: envelope.vaultID,
    generationEpoch: envelope.generationEpoch,
    actorDeviceID: envelope.actorDeviceID,
    targetDeviceID: envelope.targetDeviceID ?? null,
    authEpoch: envelope.authEpoch,
    credentialEpoch: envelope.credentialEpoch,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    deviceSignature: envelope.deviceSignature,
  };
}

/** Fixed case-insensitive name, exactly one canonical base64url value, <=8 KiB encoded. */
export function signedRequestHeader(envelope: SignedDeviceRequestEnvelope): ProtocolHeader {
  return {
    name: signedRequestHeaderName,
    value: base64url(canonicalJSONBytes(signedEnvelopeJSON(envelope))),
  };
}

export function decodeSignedRequestHeader(
  headers: readonly ProtocolHeader[],
): SignedDeviceRequestEnvelope {
  const values = headers
    .filter((header) => header.name.toLowerCase() === signedRequestHeaderName.toLowerCase())
    .map((header) => header.value);
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.length > maximumSignedRequestHeaderLength)
    throw new TypeError("Exactly one bounded Enchiridion-Signed-Request header is required.");
  const bytes = fromBase64url(value);
  if (bytes === undefined)
    throw new TypeError("Signed request header must be canonical base64url.");
  let source: string;
  try {
    // Keep a leading UTF-8 BOM visible so strict JSON rejects it too.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypeError("Signed request header must decode as valid UTF-8.");
  }
  return validateSignedDeviceRequestEnvelope(parseJSONWithoutDuplicateMembers(source));
}

export interface HttpOperation {
  readonly operationID:
    | "createDeviceChallenge"
    | "registerDevice"
    | "revokeDevice"
    | "submitMutation"
    | "putBlob"
    | "deleteBlob";
  readonly method: "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly requestSchema:
    | "DeviceChallengeRequest"
    | "DeviceRegisterRequest"
    | "DeviceRevokeRequest"
    | "MutationRequest"
    | "ContentAddressedBlobOperation"
    | "BlobDeleteRequest";
  readonly successSchema:
    | "DeviceChallengeResponse"
    | "DeviceRegisterResponse"
    | "DeviceRevokeResponse"
    | "MutationResponse";
  readonly body: "canonical-json" | "binary" | "none";
  /** Raw blob operations carry their envelope in the fixed bounded header. */
  readonly signedRequestHeader?: true;
}

/** Language-neutral operation table; workers may bind routes later. */
export const httpOperations: readonly HttpOperation[] = [
  {
    operationID: "createDeviceChallenge",
    method: "POST",
    path: "/v2/devices/challenge",
    requestSchema: "DeviceChallengeRequest",
    successSchema: "DeviceChallengeResponse",
    body: "canonical-json",
  },
  {
    operationID: "registerDevice",
    method: "POST",
    path: "/v2/devices/register",
    requestSchema: "DeviceRegisterRequest",
    successSchema: "DeviceRegisterResponse",
    body: "canonical-json",
  },
  {
    operationID: "revokeDevice",
    method: "POST",
    path: "/v2/devices/{deviceId}/revoke",
    requestSchema: "DeviceRevokeRequest",
    successSchema: "DeviceRevokeResponse",
    body: "canonical-json",
  },
  {
    operationID: "submitMutation",
    method: "POST",
    path: "/v2/mutations",
    requestSchema: "MutationRequest",
    successSchema: "MutationResponse",
    body: "canonical-json",
  },
  {
    operationID: "putBlob",
    method: "PUT",
    path: "/v2/blobs/{sha256}",
    requestSchema: "ContentAddressedBlobOperation",
    successSchema: "MutationResponse",
    body: "binary",
    signedRequestHeader: true,
  },
  {
    operationID: "deleteBlob",
    method: "DELETE",
    path: "/v2/blobs/{sha256}",
    requestSchema: "BlobDeleteRequest",
    successSchema: "MutationResponse",
    body: "none",
    signedRequestHeader: true,
  },
];

export const websocketContract = {
  path: "/v2/sync",
  negotiationFailureCloseCode: 4426,
  httpNegotiationFailureStatus: 426,
  clientSchema: "ClientWebSocketFrame",
  serverSchema: "ServerWebSocketFrame",
  handshake: {
    serverFirstFrame: "ServerHelloChallengeFrame",
    clientHelloFrame: "HelloFrame",
    acceptedFrame: "HelloAcceptedFrame",
    connectionNonce: "canonical 128-bit base64url CSPRNG value",
    resumeToken:
      "optional canonical base64url in Hello; required rotated canonical base64url in HelloAccepted",
    signingPayload: {
      magic: "ENCHWSHELLO",
      version: 1,
      algorithm: "p256-sha256-der-low-s",
      canonicalBytes:
        "After rejecting challenge lifetimes outside 1,000..300,000ms and expiresAt <= caller nowMilliseconds, ASCII magic ENCHWSHELLO, u8 1, then u32-big-endian UTF-8 byte length and bytes for: hello type, challenge protocolVersion, connectionNonce, issuedAt, expiresAt, ownerID, vaultID, authEpoch, credentialEpoch, generationEpoch, hello protocolVersion, hello connectionNonce, resumeToken or literal null, deviceID, hello authEpoch.",
    },
  },
  syncChangeProof: {
    signingPayloadVersion: syncFrameSigningPayloadVersion,
    algorithm: "p256-sha256-der",
    replayKey: "deviceID:frameID:credentialEpoch:generationEpoch",
    canonicalBytes:
      "ASCII magic ENCHSYNC, u8 signingPayloadVersion, then u32-big-endian UTF-8 byte length and bytes for: protocolVersion, vaultID, deviceID, authEpoch, credentialEpoch, generationEpoch, sessionNonce, assertionExpiresAt, operationID, sourceKind, payloadSHA256, causalVersion-or-empty, frameID, payloadBase64.",
  },
} as const;
