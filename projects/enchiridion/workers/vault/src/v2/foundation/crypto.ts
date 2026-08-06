/** @enchiridion/effect-module */
import {
  type CapabilitySigner,
  type CapabilityVerifier,
  type CredentialBindingKeyRing,
  type ExternalServiceError,
  makeCapabilitySigner,
  makeCapabilityVerifier,
  signCapabilityHmac,
  verifyCapabilityHmac,
} from "@enchiridion/runtime";
import { Context, Data, Effect, Layer } from "effect";
import { VaultV2Config } from "./config";
import type { OpaqueAccessSubject } from "./schemas";

const digestPattern = /^v[12]\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{43}$/u;

export class IssuerHashError extends Data.TaggedError("IssuerHashError")<{
  readonly reason: "malformed_issuer" | "unknown_key" | "crypto_failed";
}> {}

/**
 * HMAC-authenticated value token. Its private WeakSet provenance prevents callers from turning a
 * valid-looking persisted string (or a copied object) into directory authority.
 */
export interface AuthenticatedCredentialBindingDigest {
  readonly value: string;
}
export type CredentialBindingDigest = AuthenticatedCredentialBindingDigest;

/** Canonical Access issuer derived from already signature-verified claims. */
export type VerifiedAccessIssuer = string;

const digestTokens = new WeakSet<object>();
const digest = (value: string): CredentialBindingDigest => {
  const authenticated: CredentialBindingDigest = Object.freeze({ value });
  digestTokens.add(authenticated);
  return authenticated;
};

export const isCredentialBindingDigest = (value: unknown): value is CredentialBindingDigest =>
  typeof value === "object" && value !== null && digestTokens.has(value);

/** Shape-only durable-wire check. It never authenticates or mints a directory token. */
export const isCredentialBindingDigestWireValue = (value: unknown): value is string =>
  typeof value === "string" && digestPattern.test(value);

export const verifiedAccessIssuer = (value: unknown): VerifiedAccessIssuer | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length !== 0 ||
      url.password.length !== 0 ||
      url.port.length !== 0 ||
      url.pathname !== "/" ||
      url.search.length !== 0 ||
      url.hash.length !== 0
    )
      return undefined;
    return `https://${url.hostname.toLowerCase()}`;
  } catch {
    return undefined;
  }
};

export interface VerifiedAccessIdentity {
  readonly issuer: VerifiedAccessIssuer;
  readonly subject: OpaqueAccessSubject;
}

export interface VersionedIssuerHasher {
  readonly issue: (
    identity: VerifiedAccessIdentity,
  ) => Effect.Effect<CredentialBindingDigest, IssuerHashError | ExternalServiceError>;
  readonly matches: (
    identity: VerifiedAccessIdentity,
    digest: CredentialBindingDigest,
  ) => Effect.Effect<boolean, IssuerHashError | ExternalServiceError>;
}

const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const base64urlBytes = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const text = atob(padded);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
    return base64url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const issuerPayload = (version: "v1" | "v2", identity: VerifiedAccessIdentity): string =>
  `${version}\u0000${identity.issuer}\u0000${identity.subject.value}`;

const issuerParts = (
  value: unknown,
): readonly ["v1" | "v2", string, Uint8Array<ArrayBuffer>] | undefined => {
  if (!isCredentialBindingDigest(value)) return undefined;
  const parts = value.value.split(".");
  const version = parts[0];
  const keyID = parts[1];
  const signature = parts[2];
  if (
    (version !== "v1" && version !== "v2") ||
    keyID === undefined ||
    signature === undefined ||
    parts.length !== 3
  )
    return undefined;
  const bytes = base64urlBytes(signature);
  return bytes === undefined ? undefined : [version, keyID, bytes];
};

const issuerKey = (
  keys: readonly CredentialBindingKeyRing["current"][],
  keyID: string,
): CredentialBindingKeyRing["current"] | undefined => keys.find((key) => key.keyID === keyID);

/** Dual-read (`v1`/`v2`) and single-write (`v2`) binding over version NUL issuer NUL subject. */
export const makeVersionedIssuerHasher = (
  keyRing: CredentialBindingKeyRing,
): VersionedIssuerHasher => ({
  issue: (identity) =>
    Effect.flatMap(
      signCapabilityHmac(keyRing.current.secret, issuerPayload("v2", identity)),
      (signature) => Effect.succeed(digest(`v2.${keyRing.current.keyID}.${base64url(signature)}`)),
    ).pipe(Effect.mapError(() => new IssuerHashError({ reason: "crypto_failed" }))),
  matches: (identity, candidate) => {
    const parts = issuerParts(candidate);
    if (parts === undefined)
      return Effect.fail(new IssuerHashError({ reason: "malformed_issuer" }));
    const [version, keyID, signature] = parts;
    const key = issuerKey([keyRing.current, ...keyRing.prior], keyID);
    if (key === undefined) return Effect.fail(new IssuerHashError({ reason: "unknown_key" }));
    return verifyCapabilityHmac(key.secret, issuerPayload(version, identity), signature).pipe(
      Effect.mapError(() => new IssuerHashError({ reason: "crypto_failed" })),
    );
  },
});

export interface InternalCapabilityFactory {
  readonly signer: CapabilitySigner;
  readonly verifier: CapabilityVerifier;
}

export const InternalCapabilityFactory = Context.GenericTag<InternalCapabilityFactory>(
  "@enchiridion/worker-vault/v2/InternalCapabilityFactory",
);

/** Capability signing gets config-owned, separate Redacted material from issuer hashing. */
export const makeInternalCapabilityFactory = Effect.gen(function* () {
  const config = yield* VaultV2Config;
  return {
    signer: makeCapabilitySigner(config.internalCapabilityKeys),
    verifier: makeCapabilityVerifier(config.internalCapabilityKeys),
  };
});

export const layerInternalCapabilityFactory: Layer.Layer<
  InternalCapabilityFactory,
  never,
  VaultV2Config
> = Layer.effect(InternalCapabilityFactory, makeInternalCapabilityFactory);
