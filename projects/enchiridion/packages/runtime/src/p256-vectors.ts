/**
 * Public, non-secret interoperability vector. Swift consumers can decode the
 * Base64 DER SPKI/signature and UTF-8 message to prove the same P-256 profile.
 */
export const p256VerificationVector = {
  profile: "P-256 / SHA-256 / DER ECDSA input / fixed-width P1363 WebCrypto verification",
  messageUTF8: "enchiridion-p256-vector-v1",
  spkiDERBase64:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeRo6IA5qHb0Clfwa7yCD4u0UOVCKLCcaGkWz1/94iIrBm/IjXooNCCb3LCnkD8iM899EHZ3CswgZ3zSXHHERUA==",
  signatureDERBase64:
    "MEUCIAhuct4nQVQ+EM8E/SO276+ShsnLH6IwluYQmbFity9OAiEA4tuyy1ClEUo8PY0BvAxPYjHdF3N5P1d/au7gYjc6ctY=",
} as const;
