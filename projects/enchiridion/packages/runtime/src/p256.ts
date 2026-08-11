import { Context, Effect, Layer } from "effect";
import { randomP256Bytes32, verifyP256Ecdsa } from "./adapters";
import { P256VerificationError } from "./errors";

export interface P256VerificationRequest {
  /** Canonical DER SubjectPublicKeyInfo for id-ecPublicKey / prime256v1. */
  readonly spkiDER: Uint8Array;
  /** Bytes signed by the native device; this service never applies text normalization. */
  readonly message: Uint8Array;
  /** Canonical ASN.1 DER ECDSA sequence of positive r and s integers. */
  readonly signatureDER: Uint8Array;
}

export interface P256Crypto {
  readonly verify: (request: P256VerificationRequest) => Effect.Effect<void, P256VerificationError>;
  readonly random32: () => Effect.Effect<Uint8Array<ArrayBuffer>, P256VerificationError>;
}

export const P256Crypto = Context.GenericTag<P256Crypto>("@enchiridion/runtime/P256Crypto");

const maximumMessageBytes = 1_048_576;
const p256PointBytes = 65;
const p256SpkiPrefix = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
/** secp256r1 group order, encoded as exactly 32 big-endian octets. */
const p256Order = new Uint8Array([
  0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
]);
/** floor(n / 2); accepting only s <= this prevents ECDSA signature malleability. */
const p256HalfOrder = new Uint8Array([
  0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
]);

const copy = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

const failure = <A>(
  reason: P256VerificationError["reason"],
): Effect.Effect<A, P256VerificationError> => Effect.fail(new P256VerificationError({ reason }));

/** Accepts exactly one canonical P-256 SPKI DER encoding; no BER/alternate algorithm spelling is admitted. */
export const canonicalP256Spki = (input: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  if (input.byteLength !== p256SpkiPrefix.byteLength + 64) return undefined;
  for (let index = 0; index < p256SpkiPrefix.byteLength; index += 1) {
    if (input[index] !== p256SpkiPrefix[index]) return undefined;
  }
  const pointOffset = p256SpkiPrefix.byteLength - 1;
  if (input[pointOffset] !== 0x04 || input.byteLength - pointOffset !== p256PointBytes)
    return undefined;
  return copy(input);
};

const singleByteLength = (input: Uint8Array, offset: number): number | undefined => {
  const length = input[offset];
  return length === undefined || length > 0x7f ? undefined : length;
};

const readPositiveInteger = (
  input: Uint8Array,
  offset: number,
): readonly [Uint8Array, number] | undefined => {
  if (input[offset] !== 0x02) return undefined;
  const length = singleByteLength(input, offset + 1);
  const start = offset + 2;
  if (length === undefined || length < 1 || start + length > input.byteLength || length > 33)
    return undefined;
  const value = input.slice(start, start + length);
  const first = value[0];
  const second = value[1];
  if (first === undefined || (first & 0x80) !== 0) return undefined;
  if (value.byteLength > 1 && first === 0 && second !== undefined && (second & 0x80) === 0)
    return undefined;
  if (value.byteLength === 33 && first !== 0) return undefined;
  const magnitude = first === 0 ? value.slice(1) : value;
  if (magnitude.byteLength < 1 || magnitude.byteLength > 32) return undefined;
  return [magnitude, start + length];
};

const compareBigEndian = (left: Uint8Array, right: Uint8Array): number => {
  for (let index = 0; index < left.byteLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const subtractBigEndian = (left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(left.byteLength);
  let borrow = 0;
  for (let index = left.byteLength - 1; index >= 0; index -= 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0) - borrow;
    output[index] = difference < 0 ? difference + 256 : difference;
    borrow = difference < 0 ? 1 : 0;
  }
  return output;
};

/** Produces a fixed scalar only when it is in [1, n - 1]. */
const canonicalScalar = (magnitude: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  const scalar = new Uint8Array(32);
  scalar.set(magnitude, 32 - magnitude.byteLength);
  const nonZero = scalar.some((byte) => byte !== 0);
  return nonZero && compareBigEndian(scalar, p256Order) < 0 ? scalar : undefined;
};

/** Strict canonical ASN.1 DER ECDSA `SEQUENCE(INTEGER r, INTEGER s)` to Web Crypto P1363. */
export const p256DerSignatureToP1363 = (input: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  if (input[0] !== 0x30) return undefined;
  const sequenceLength = singleByteLength(input, 1);
  if (sequenceLength === undefined || sequenceLength !== input.byteLength - 2) return undefined;
  const r = readPositiveInteger(input, 2);
  if (r === undefined) return undefined;
  const s = readPositiveInteger(input, r[1]);
  if (s === undefined || s[1] !== input.byteLength) return undefined;
  const rScalar = canonicalScalar(r[0]);
  const sScalar = canonicalScalar(s[0]);
  if (
    rScalar === undefined ||
    sScalar === undefined ||
    compareBigEndian(sScalar, p256HalfOrder) > 0
  )
    return undefined;
  const output = new Uint8Array(64);
  output.set(rScalar);
  output.set(sScalar, 32);
  return output;
};

const canonicalDerInteger = (scalar: Uint8Array): Uint8Array<ArrayBuffer> => {
  let first = 0;
  while (first < scalar.byteLength - 1 && scalar[first] === 0) first += 1;
  const magnitude = scalar.slice(first);
  const leadingZero = (magnitude[0] ?? 0) >= 0x80;
  const output = new Uint8Array(2 + magnitude.byteLength + (leadingZero ? 1 : 0));
  output[0] = 0x02;
  output[1] = magnitude.byteLength + (leadingZero ? 1 : 0);
  output.set(magnitude, leadingZero ? 3 : 2);
  return output;
};

/** Converts Web Crypto's P1363 output to the one canonical, low-S DER spelling.
 * Signers use this before serializing a manifest signature; verifiers can then
 * reuse `p256DerSignatureToP1363` without admitting a malleable alternate. */
export const p256P1363ToCanonicalLowSDer = (
  input: Uint8Array,
): Uint8Array<ArrayBuffer> | undefined => {
  if (input.byteLength !== 64) return undefined;
  const r = canonicalScalar(input.slice(0, 32));
  const sourceS = canonicalScalar(input.slice(32));
  if (r === undefined || sourceS === undefined) return undefined;
  const s =
    compareBigEndian(sourceS, p256HalfOrder) > 0 ? subtractBigEndian(p256Order, sourceS) : sourceS;
  const encodedR = canonicalDerInteger(r);
  const encodedS = canonicalDerInteger(s);
  const output = new Uint8Array(2 + encodedR.byteLength + encodedS.byteLength);
  output[0] = 0x30;
  output[1] = encodedR.byteLength + encodedS.byteLength;
  output.set(encodedR, 2);
  output.set(encodedS, 2 + encodedR.byteLength);
  return output;
};

export const makeP256Crypto = (): P256Crypto => ({
  verify: (request) => {
    const spki = canonicalP256Spki(request.spkiDER);
    if (spki === undefined) return failure("invalid_spki");
    if (request.message.byteLength > maximumMessageBytes) return failure("invalid_input");
    const signature = p256DerSignatureToP1363(request.signatureDER);
    if (signature === undefined) return failure("malformed_signature");
    return verifyP256Ecdsa(spki, copy(request.message), signature).pipe(
      Effect.mapError(() => new P256VerificationError({ reason: "crypto_unavailable" })),
      Effect.flatMap((verified) => (verified ? Effect.void : failure<void>("signature_invalid"))),
    );
  },
  random32: () =>
    randomP256Bytes32().pipe(
      Effect.mapError(() => new P256VerificationError({ reason: "crypto_unavailable" })),
      Effect.flatMap((bytes) =>
        bytes.byteLength === 32 ? Effect.succeed(bytes) : failure("crypto_unavailable"),
      ),
    ),
});

/** Production P-256 service layer for Worker composition. */
export const p256CryptoLayer = Layer.succeed(P256Crypto, makeP256Crypto());
