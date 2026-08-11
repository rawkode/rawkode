import { Config, Effect, Redacted } from "effect";
import {
  signManifestP256,
  validateManifestP256KeyPair,
  validateManifestP256PublicKey,
} from "./adapters";
import {
  ManifestKeyRingConfigurationError,
  ManifestSigningError,
  ManifestVerificationError,
  type P256VerificationError,
} from "./errors";
import { canonicalP256Spki, makeP256Crypto, p256P1363ToCanonicalLowSDer } from "./p256";

const keyIDPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const maximumManifestBytes = 4 * 1_024 * 1_024;
export const maximumPriorManifestKeys = 3;

/** A verification key only. The private counterpart is permitted exclusively
 * on the current signing key and is Redacted at every public boundary. */
export interface ManifestVerificationKeyMaterial {
  readonly keyID: string;
  readonly publicKeySPKIDERBase64: string;
}

export interface ManifestSigningKeyMaterial extends ManifestVerificationKeyMaterial {
  readonly privateKeyPKCS8Base64: Redacted.Redacted;
}

/** Distinct asymmetric ring for signed backup manifests. It is intentionally
 * not assignable to either capability HMAC ring. */
export interface ManifestP256KeyRing {
  readonly purpose: "backup-manifest-p256";
  readonly current: ManifestSigningKeyMaterial;
  readonly prior: readonly ManifestVerificationKeyMaterial[];
  readonly revokedKeyIDs: readonly string[];
}

export interface ManifestSignature {
  readonly keyID: string;
  /** Standard base64 of canonical, low-S DER ECDSA. */
  readonly signatureDERBase64: string;
}

export interface ManifestSigner {
  readonly signCanonical: (
    canonicalBytes: Uint8Array,
  ) => Effect.Effect<ManifestSignature, ManifestSigningError>;
}

export interface ManifestVerifier {
  readonly verifyCanonical: (
    canonicalBytes: Uint8Array,
    signature: ManifestSignature,
  ) => Effect.Effect<void, ManifestVerificationError>;
}

/** Typed environment input for a single current signing key. Prior and
 * revocation lists are deployment configuration, not a RuntimeConfig field. */
export const manifestSigningKeySource = Config.all({
  keyID: Config.string("ENCHIRIDION_MANIFEST_SIGNING_KEY_ID"),
  privateKeyPKCS8Base64: Config.redacted("ENCHIRIDION_MANIFEST_SIGNING_PKCS8_BASE64"),
  publicKeySPKIDERBase64: Config.string("ENCHIRIDION_MANIFEST_SIGNING_SPKI_BASE64"),
});

const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

const fromCanonicalBase64 = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
    return undefined;
  try {
    const binary = atob(value);
    const output = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return toBase64(output) === value ? output : undefined;
  } catch {
    return undefined;
  }
};

const validCanonicalBytes = (bytes: Uint8Array): boolean =>
  bytes.byteLength > 0 && bytes.byteLength <= maximumManifestBytes;

const arrayBufferCopy = (source: Uint8Array): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

/** Construction validates key material, but public factories also defend
 * against a structurally forged ring. Every active and retired identifier is
 * canonical ASCII, bounded to 64 bytes, unique, and never both active/revoked. */
const validKeyRingIDs = (keyRing: ManifestP256KeyRing): boolean => {
  const active = [keyRing.current.keyID, ...keyRing.prior.map((key) => key.keyID)];
  const revoked = keyRing.revokedKeyIDs;
  return (
    keyRing.prior.length <= maximumPriorManifestKeys &&
    active.every((keyID) => keyIDPattern.test(keyID)) &&
    revoked.every((keyID) => keyIDPattern.test(keyID)) &&
    new Set(active).size === active.length &&
    new Set(revoked).size === revoked.length &&
    !active.some((keyID) => revoked.includes(keyID))
  );
};

const configurationFailure = (
  reason: ManifestKeyRingConfigurationError["reason"],
): ManifestKeyRingConfigurationError => new ManifestKeyRingConfigurationError({ reason });

const validateVerificationKey = (
  material: ManifestVerificationKeyMaterial,
): Effect.Effect<ManifestVerificationKeyMaterial, ManifestKeyRingConfigurationError> => {
  if (!keyIDPattern.test(material.keyID))
    return Effect.fail(configurationFailure("invalid_key_id"));
  const spki = fromCanonicalBase64(material.publicKeySPKIDERBase64);
  if (spki === undefined || canonicalP256Spki(spki) === undefined)
    return Effect.fail(configurationFailure("invalid_public_key"));
  return validateManifestP256PublicKey(spki).pipe(
    Effect.mapError(() => configurationFailure("invalid_public_key")),
    Effect.as(material),
  );
};

const validateSigningKey = (
  material: ManifestSigningKeyMaterial,
): Effect.Effect<ManifestSigningKeyMaterial, ManifestKeyRingConfigurationError> => {
  if (!keyIDPattern.test(material.keyID))
    return Effect.fail(configurationFailure("invalid_key_id"));
  const privateKey = fromCanonicalBase64(Redacted.value(material.privateKeyPKCS8Base64));
  if (privateKey === undefined || privateKey.byteLength < 64 || privateKey.byteLength > 512)
    return Effect.fail(configurationFailure("invalid_private_key"));
  const spki = fromCanonicalBase64(material.publicKeySPKIDERBase64);
  if (spki === undefined || canonicalP256Spki(spki) === undefined)
    return Effect.fail(configurationFailure("invalid_public_key"));
  return validateManifestP256KeyPair(material.privateKeyPKCS8Base64, spki).pipe(
    Effect.mapError(() => configurationFailure("key_pair_mismatch")),
    Effect.as(material),
  );
};

export const makeManifestP256KeyRing = (input: {
  readonly current: ManifestSigningKeyMaterial;
  readonly prior?: readonly ManifestVerificationKeyMaterial[];
  readonly revokedKeyIDs?: readonly string[];
}): Effect.Effect<ManifestP256KeyRing, ManifestKeyRingConfigurationError> =>
  Effect.gen(function* () {
    const prior = input.prior ?? [];
    const revokedKeyIDs = input.revokedKeyIDs ?? [];
    if (prior.length > maximumPriorManifestKeys)
      return yield* Effect.fail(configurationFailure("too_many_prior_keys"));
    const current = yield* validateSigningKey(input.current);
    const validatedPrior = yield* Effect.all(prior.map(validateVerificationKey));
    if (!revokedKeyIDs.every((keyID) => keyIDPattern.test(keyID)))
      return yield* Effect.fail(configurationFailure("invalid_key_id"));
    const activeIDs = [current.keyID, ...validatedPrior.map((key) => key.keyID)];
    if (
      new Set(activeIDs).size !== activeIDs.length ||
      new Set(revokedKeyIDs).size !== revokedKeyIDs.length
    )
      return yield* Effect.fail(configurationFailure("duplicate_key_id"));
    if (activeIDs.some((keyID) => revokedKeyIDs.includes(keyID)))
      return yield* Effect.fail(configurationFailure("revoked_key_active"));
    return {
      purpose: "backup-manifest-p256",
      current,
      prior: validatedPrior,
      revokedKeyIDs,
    };
  });

export const makeManifestSigner = (keyRing: ManifestP256KeyRing): ManifestSigner => ({
  signCanonical: (canonicalBytes) => {
    if (!validCanonicalBytes(canonicalBytes))
      return Effect.fail(new ManifestSigningError({ reason: "invalid_bytes" }));
    if (!validKeyRingIDs(keyRing))
      return Effect.fail(new ManifestSigningError({ reason: "invalid_key_configuration" }));
    return signManifestP256(
      keyRing.current.privateKeyPKCS8Base64,
      arrayBufferCopy(canonicalBytes),
    ).pipe(
      Effect.flatMap((p1363) => {
        const signatureDER = p256P1363ToCanonicalLowSDer(p1363);
        return signatureDER === undefined
          ? Effect.fail(new ManifestSigningError({ reason: "crypto_unavailable" }))
          : Effect.succeed({
              keyID: keyRing.current.keyID,
              signatureDERBase64: toBase64(signatureDER),
            });
      }),
      Effect.mapError(() => new ManifestSigningError({ reason: "crypto_unavailable" })),
    );
  },
});

const verificationFailure = (error: P256VerificationError): ManifestVerificationError => {
  if (error.reason === "malformed_signature")
    return new ManifestVerificationError({ reason: "malformed_signature" });
  if (error.reason === "signature_invalid")
    return new ManifestVerificationError({ reason: "signature_invalid" });
  return new ManifestVerificationError({ reason: "crypto_unavailable" });
};

export const makeManifestVerifier = (keyRing: ManifestP256KeyRing): ManifestVerifier => ({
  verifyCanonical: (canonicalBytes, signature) => {
    if (!validCanonicalBytes(canonicalBytes))
      return Effect.fail(new ManifestVerificationError({ reason: "invalid_bytes" }));
    if (!validKeyRingIDs(keyRing))
      return Effect.fail(new ManifestVerificationError({ reason: "unknown_or_revoked_key" }));
    if (!keyIDPattern.test(signature.keyID) || keyRing.revokedKeyIDs.includes(signature.keyID))
      return Effect.fail(new ManifestVerificationError({ reason: "unknown_or_revoked_key" }));
    const key = [keyRing.current, ...keyRing.prior].find(
      (candidate) => candidate.keyID === signature.keyID,
    );
    if (key === undefined)
      return Effect.fail(new ManifestVerificationError({ reason: "unknown_or_revoked_key" }));
    const spki = fromCanonicalBase64(key.publicKeySPKIDERBase64);
    const signatureDER = fromCanonicalBase64(signature.signatureDERBase64);
    if (spki === undefined || signatureDER === undefined)
      return Effect.fail(new ManifestVerificationError({ reason: "malformed_signature" }));
    return makeP256Crypto()
      .verify({ spkiDER: spki, message: canonicalBytes, signatureDER })
      .pipe(Effect.mapError(verificationFailure));
  },
});
