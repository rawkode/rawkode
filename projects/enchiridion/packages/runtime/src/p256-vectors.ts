/**
 * Public, non-secret interoperability vector. Swift consumers can decode the
 * Base64 DER SPKI/signature and UTF-8 message to prove the same P-256 profile.
 */
export const p256VerificationVector = {
  profile:
    "P-256 / SHA-256 / canonical DER ECDSA (1 <= r,s < n; low-S s <= floor(n/2)) / fixed-width 64-byte P1363 WebCrypto verification",
  messageUTF8: "enchiridion-p256-vector-v1",
  spkiDERBase64:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeRo6IA5qHb0Clfwa7yCD4u0UOVCKLCcaGkWz1/94iIrBm/IjXooNCCb3LCnkD8iM899EHZ3CswgZ3zSXHHERUA==",
  signatureDERBase64:
    "MEQCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiAdJE0zr1rutsPCcv5D87CdiwnjOi3YRwWIyupgxSiyew==",
} as const;
