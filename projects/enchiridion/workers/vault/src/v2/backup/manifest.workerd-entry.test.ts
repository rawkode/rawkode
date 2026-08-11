/** Real Workerd-only P-256 manifest signing fixture. */
import {
  makeManifestP256KeyRing,
  makeManifestSigner,
  makeManifestVerifier,
  p256VerificationVector,
} from "@enchiridion/runtime";
import { Effect, Exit, Redacted } from "effect";

const privateKey =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnqgn2CchsOl0SE25sbl1fSF4GeFyIyhcGXfmk+nORRihRANCAARgDj/LiRqx4+xQpW1yKXYVWEGHCg+4hJxT4PbHMBrFWthHzkiAYKYvic295OBVCfvBwjOQEZVKtWmC+t+IMFbF";
const publicKey =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYA4/y4kasePsUKVtcil2FVhBhwoPuIScU+D2xzAaxVrYR85IgGCmL4nNveTgVQn7wcIzkBGVSrVpgvrfiDBWxQ==";
const highS =
  "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=";
const message = new TextEncoder().encode("workerd-backup-manifest-v1");

const current = {
  keyID: "manifest-current",
  privateKeyPKCS8Base64: Redacted.make(privateKey),
  publicKeySPKIDERBase64: publicKey,
};
const prior = {
  keyID: "manifest-prior",
  publicKeySPKIDERBase64: p256VerificationVector.spkiDERBase64,
};

const responseFor = async (pathname: string): Promise<Response> => {
  const ring = await Effect.runPromise(makeManifestP256KeyRing({ current, prior: [prior] }));
  const signer = makeManifestSigner(ring);
  const verifier = makeManifestVerifier(ring);
  if (pathname === "/current") {
    const signature = await Effect.runPromise(signer.signCanonical(message));
    await Effect.runPromise(verifier.verifyCanonical(message, signature));
    return new Response("current");
  }
  if (pathname === "/prior") {
    await Effect.runPromise(
      verifier.verifyCanonical(new TextEncoder().encode(p256VerificationVector.messageUTF8), {
        keyID: prior.keyID,
        signatureDERBase64: p256VerificationVector.signatureDERBase64,
      }),
    );
    return new Response("prior");
  }
  if (pathname === "/revoked") {
    const revokedRing = await Effect.runPromise(
      makeManifestP256KeyRing({ current, revokedKeyIDs: [prior.keyID] }),
    );
    const result = await Effect.runPromiseExit(
      makeManifestVerifier(revokedRing).verifyCanonical(
        new TextEncoder().encode(p256VerificationVector.messageUTF8),
        { keyID: prior.keyID, signatureDERBase64: p256VerificationVector.signatureDERBase64 },
      ),
    );
    return Exit.isFailure(result)
      ? new Response("revoked")
      : new Response("unexpected", { status: 500 });
  }
  const signature = await Effect.runPromise(signer.signCanonical(message));
  const candidate =
    pathname === "/tamper"
      ? { ...signature, signatureDERBase64: `${signature.signatureDERBase64.slice(0, -4)}AAAA` }
      : { keyID: prior.keyID, signatureDERBase64: highS };
  const signedMessage =
    pathname === "/tamper" ? message : new TextEncoder().encode(p256VerificationVector.messageUTF8);
  const result = await Effect.runPromiseExit(verifier.verifyCanonical(signedMessage, candidate));
  return Exit.isFailure(result)
    ? new Response(pathname.slice(1))
    : new Response("unexpected", { status: 500 });
};

export default {
  fetch: (request: Request): Promise<Response> => responseFor(new URL(request.url).pathname),
};
