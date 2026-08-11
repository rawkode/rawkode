import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";
import {
  makeManifestP256KeyRing,
  makeManifestSigner,
  makeManifestVerifier,
  p256VerificationVector,
} from "./index";

const testPrivateKeyPKCS8 =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";
const testPublicKeySPKI =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYA4/y4kasePsUKVtcil2FVhBhwoPuIScU+D2xzAaxVrYR85IgGCmL4nNveTgVQn7wcIzkBGVSrVpgvrfiDBWxQ==";
const decode = (base64: string): Uint8Array => {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

describe("P-256 backup manifest key ring", () => {
  test("signs canonical bytes with the current Redacted key and verifies only a current/prior key ID", async () => {
    const ring = await Effect.runPromise(
      makeManifestP256KeyRing({
        current: {
          keyID: "manifest-current",
          privateKeyPKCS8Base64: Redacted.make(testPrivateKeyPKCS8),
          publicKeySPKIDERBase64: testPublicKeySPKI,
        },
        prior: [
          {
            keyID: "protocol-vector-prior",
            publicKeySPKIDERBase64: p256VerificationVector.spkiDERBase64,
          },
        ],
      }),
    );
    const message = new TextEncoder().encode("canonical-backup-manifest-v1");
    const signature = await Effect.runPromise(makeManifestSigner(ring).signCanonical(message));
    expect(signature.keyID).toBe("manifest-current");
    expect(decode(signature.signatureDERBase64)[0]).toBe(0x30);
    await Effect.runPromise(makeManifestVerifier(ring).verifyCanonical(message, signature));

    await Effect.runPromise(
      makeManifestVerifier(ring).verifyCanonical(
        new TextEncoder().encode(p256VerificationVector.messageUTF8),
        {
          keyID: "protocol-vector-prior",
          signatureDERBase64: p256VerificationVector.signatureDERBase64,
        },
      ),
    );
  });

  test("fails closed for revoked/unknown key IDs, tampering, and invalid ring material", async () => {
    const ring = await Effect.runPromise(
      makeManifestP256KeyRing({
        current: {
          keyID: "manifest-current",
          privateKeyPKCS8Base64: Redacted.make(testPrivateKeyPKCS8),
          publicKeySPKIDERBase64: testPublicKeySPKI,
        },
        revokedKeyIDs: ["retired-key"],
      }),
    );
    const message = new TextEncoder().encode("canonical-backup-manifest-v1");
    const signature = await Effect.runPromise(makeManifestSigner(ring).signCanonical(message));
    const verifier = makeManifestVerifier(ring);
    const revoked = await Effect.runPromiseExit(
      verifier.verifyCanonical(message, { ...signature, keyID: "retired-key" }),
    );
    const tampered = await Effect.runPromiseExit(
      verifier.verifyCanonical(new TextEncoder().encode("tampered"), signature),
    );
    expect(Exit.isFailure(revoked)).toBe(true);
    expect(JSON.stringify(revoked)).toContain("unknown_or_revoked_key");
    expect(Exit.isFailure(tampered)).toBe(true);
    expect(JSON.stringify(tampered)).toContain("signature_invalid");

    const invalid = await Effect.runPromiseExit(
      makeManifestP256KeyRing({
        current: {
          keyID: "manifest-current",
          privateKeyPKCS8Base64: Redacted.make("not-a-key"),
          publicKeySPKIDERBase64: testPublicKeySPKI,
        },
      }),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain(testPrivateKeyPKCS8);

    const mismatch = await Effect.runPromiseExit(
      makeManifestP256KeyRing({
        current: {
          keyID: "manifest-current",
          privateKeyPKCS8Base64: Redacted.make(testPrivateKeyPKCS8),
          publicKeySPKIDERBase64: p256VerificationVector.spkiDERBase64,
        },
      }),
    );
    expect(Exit.isFailure(mismatch)).toBe(true);
    expect(JSON.stringify(mismatch)).toContain("key_pair_mismatch");
  });

  test("bounds canonical key IDs at construction and again at sign/verify use", async () => {
    const current = {
      keyID: "manifest-current",
      privateKeyPKCS8Base64: Redacted.make(testPrivateKeyPKCS8),
      publicKeySPKIDERBase64: testPublicKeySPKI,
    };
    const tooLong = "a".repeat(65);
    const construction = await Effect.runPromiseExit(
      makeManifestP256KeyRing({ current: { ...current, keyID: tooLong } }),
    );
    expect(Exit.isFailure(construction)).toBe(true);
    expect(JSON.stringify(construction)).toContain("invalid_key_id");

    const ring = await Effect.runPromise(makeManifestP256KeyRing({ current }));
    const message = new TextEncoder().encode("canonical-backup-manifest-v1");
    const malformedCurrent = { ...ring, current: { ...ring.current, keyID: tooLong } };
    const sign = await Effect.runPromiseExit(
      makeManifestSigner(malformedCurrent).signCanonical(message),
    );
    expect(Exit.isFailure(sign)).toBe(true);
    expect(JSON.stringify(sign)).toContain("invalid_key_configuration");

    const signature = await Effect.runPromise(makeManifestSigner(ring).signCanonical(message));
    const malformedRevocation = { ...ring, revokedKeyIDs: [tooLong] };
    const verify = await Effect.runPromiseExit(
      makeManifestVerifier(malformedRevocation).verifyCanonical(message, signature),
    );
    expect(Exit.isFailure(verify)).toBe(true);
    expect(JSON.stringify(verify)).toContain("unknown_or_revoked_key");
  });
});
