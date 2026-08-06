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

/** Strict canonical ASN.1 DER ECDSA `SEQUENCE(INTEGER r, INTEGER s)` to Web Crypto P1363. */
export const p256DerSignatureToP1363 = (input: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  if (input[0] !== 0x30) return undefined;
  const sequenceLength = singleByteLength(input, 1);
  if (sequenceLength === undefined || sequenceLength !== input.byteLength - 2) return undefined;
  const r = readPositiveInteger(input, 2);
  if (r === undefined) return undefined;
  const s = readPositiveInteger(input, r[1]);
  if (s === undefined || s[1] !== input.byteLength) return undefined;
  const output = new Uint8Array(64);
  output.set(r[0], 32 - r[0].byteLength);
  output.set(s[0], 64 - s[0].byteLength);
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
