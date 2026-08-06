import { describe, expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import {
  P256Crypto,
  canonicalP256Spki,
  makeP256Crypto,
  p256CryptoLayer,
  p256DerSignatureToP1363,
} from "./p256";
import { p256VerificationVector } from "./p256-vectors";

const bytes = (base64: string): Uint8Array => {
  const text = atob(base64);
  const output = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) output[index] = text.charCodeAt(index);
  return output;
};

const encoder = new TextEncoder();
const request = {
  spkiDER: bytes(p256VerificationVector.spkiDERBase64),
  message: encoder.encode(p256VerificationVector.messageUTF8),
  signatureDER: bytes(p256VerificationVector.signatureDERBase64),
};

describe("P-256 runtime adapter", () => {
  test("accepts only canonical P-256 SPKI and canonical DER integer encodings", () => {
    expect(canonicalP256Spki(request.spkiDER)).toHaveLength(91);
    const altered = new Uint8Array(request.spkiDER);
    altered[2] = 0x31;
    expect(canonicalP256Spki(altered)).toBeUndefined();
    expect(p256DerSignatureToP1363(request.signatureDER)).toHaveLength(64);
    expect(
      p256DerSignatureToP1363(
        new Uint8Array([0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01]),
      ),
    ).toBeUndefined();
    expect(p256DerSignatureToP1363(new Uint8Array([0x30, 0x81, 0x01]))).toBeUndefined();
  });

  test("executes the published vector through Bun/Workerd-compatible Web Crypto", async () => {
    const crypto = makeP256Crypto();
    await Effect.runPromise(crypto.verify(request));
    const random = await Effect.runPromise(crypto.random32());
    expect(random).toHaveLength(32);
  });

  test("exports a composable Effect Layer rather than a raw Context value", async () => {
    const composed = Layer.mergeAll(p256CryptoLayer, Layer.empty);
    await Effect.runPromise(
      Effect.gen(function* () {
        const crypto = yield* P256Crypto;
        yield* crypto.verify(request);
      }).pipe(Effect.provide(composed)),
    );
  });

  test("fails closed for tampering without exposing cryptographic bytes", async () => {
    const crypto = makeP256Crypto();
    const tampered = new Uint8Array(request.message);
    const first = tampered[0];
    if (first === undefined) throw new Error("vector message is unexpectedly empty");
    tampered[0] = first ^ 1;
    const exit = await Effect.runPromiseExit(crypto.verify({ ...request, message: tampered }));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("signature_invalid");
    expect(JSON.stringify(exit)).not.toContain(p256VerificationVector.signatureDERBase64);
  });
});
