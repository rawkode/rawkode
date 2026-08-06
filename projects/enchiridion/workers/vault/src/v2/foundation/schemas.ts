/** @enchiridion/effect-module */
import { protocolVersion } from "@enchiridion/protocol";

const identifier = /^[A-Za-z0-9._~-]{1,128}$/u;
const requestIdentifier = /^[A-Za-z0-9_-]{16,128}$/u;
const epoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Authenticated value tokens are deliberately objects, not nominal strings: a runtime WeakSet
 * proves provenance even when TypeScript's compile-time brands or copied properties are bypassed.
 */
export interface OwnerID {
  readonly value: string;
}
export interface VaultID {
  readonly value: string;
}
export interface CredentialID {
  readonly value: string;
}
export interface RequestID {
  readonly value: string;
}
/** Validated opaque subject; never store, serialize, or expose it beyond issuer hashing. */
export interface OpaqueAccessSubject {
  readonly value: string;
}

const ownerTokens = new WeakSet<object>();
const vaultTokens = new WeakSet<object>();
const credentialTokens = new WeakSet<object>();
const requestTokens = new WeakSet<object>();
const subjectTokens = new WeakSet<object>();

const ownerToken = (value: string): OwnerID => {
  const authenticated: OwnerID = Object.freeze({ value });
  ownerTokens.add(authenticated);
  return authenticated;
};
const vaultToken = (value: string): VaultID => {
  const authenticated: VaultID = Object.freeze({ value });
  vaultTokens.add(authenticated);
  return authenticated;
};
const credentialToken = (value: string): CredentialID => {
  const authenticated: CredentialID = Object.freeze({ value });
  credentialTokens.add(authenticated);
  return authenticated;
};
const requestToken = (value: string): RequestID => {
  const authenticated: RequestID = Object.freeze({ value });
  requestTokens.add(authenticated);
  return authenticated;
};
const subjectToken = (value: string): OpaqueAccessSubject => {
  const authenticated: OpaqueAccessSubject = Object.freeze({ value });
  subjectTokens.add(authenticated);
  return authenticated;
};

/** Safe failable wire parsers; no public constructor can mint a token. */
export const ownerID = (value: unknown): OwnerID | undefined =>
  typeof value === "string" && identifier.test(value) ? ownerToken(value) : undefined;
export const vaultID = (value: unknown): VaultID | undefined =>
  typeof value === "string" && identifier.test(value) ? vaultToken(value) : undefined;
export const credentialID = (value: unknown): CredentialID | undefined =>
  typeof value === "string" && identifier.test(value) ? credentialToken(value) : undefined;
export const requestID = (value: unknown): RequestID | undefined =>
  typeof value === "string" && requestIdentifier.test(value) ? requestToken(value) : undefined;
export const opaqueAccessSubject = (value: unknown): OpaqueAccessSubject | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= 512
    ? subjectToken(value)
    : undefined;

/** Provenance checks, intentionally stronger than string-pattern checks, guard directory APIs. */
export const isOwnerID = (value: unknown): value is OwnerID =>
  typeof value === "object" && value !== null && ownerTokens.has(value);
export const isVaultID = (value: unknown): value is VaultID =>
  typeof value === "object" && value !== null && vaultTokens.has(value);
export const isCredentialID = (value: unknown): value is CredentialID =>
  typeof value === "object" && value !== null && credentialTokens.has(value);
export const isRequestID = (value: unknown): value is RequestID =>
  typeof value === "object" && value !== null && requestTokens.has(value);
export const isOpaqueAccessSubject = (value: unknown): value is OpaqueAccessSubject =>
  typeof value === "object" && value !== null && subjectTokens.has(value);

export interface AccessClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly sub: OpaqueAccessSubject;
}

export interface AccessProtectedHeader {
  readonly alg: "RS256";
  readonly typ: "JWT";
  readonly kid: string;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

export const accessProtectedHeader = (value: unknown): AccessProtectedHeader | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    source.alg !== "RS256" ||
    source.typ !== "JWT" ||
    typeof source.kid !== "string" ||
    !identifier.test(source.kid)
  )
    return undefined;
  return { alg: "RS256", typ: "JWT", kid: source.kid };
};

export const accessClaims = (value: unknown): AccessClaims | undefined => {
  const source = record(value);
  if (
    source === undefined ||
    typeof source.iss !== "string" ||
    !epoch(source.iat) ||
    !epoch(source.nbf) ||
    !epoch(source.exp)
  )
    return undefined;
  const verifiedSubject = opaqueAccessSubject(source.sub);
  if (verifiedSubject === undefined) return undefined;
  if (
    typeof source.aud !== "string" &&
    (!Array.isArray(source.aud) || !source.aud.every((audience) => typeof audience === "string"))
  )
    return undefined;
  return {
    iss: source.iss,
    aud: source.aud,
    iat: source.iat,
    nbf: source.nbf,
    exp: source.exp,
    sub: verifiedSubject,
  };
};

export const hasAudience = (claims: AccessClaims, audience: string): boolean =>
  typeof claims.aud === "string" ? claims.aud === audience : claims.aud.includes(audience);

export const validAccessTimes = (claims: AccessClaims, nowSeconds: number): boolean =>
  claims.iat <= claims.nbf &&
  claims.nbf <= claims.exp &&
  claims.iat <= nowSeconds &&
  claims.nbf <= nowSeconds &&
  claims.exp > nowSeconds;

export interface DirectoryIdentity {
  readonly ownerID: OwnerID;
  readonly vaultID: VaultID;
  readonly generationEpoch: number;
}

export const validDirectoryIdentity = (value: DirectoryIdentity): boolean =>
  epoch(value.generationEpoch) && isOwnerID(value.ownerID) && isVaultID(value.vaultID);

/** Ensures foundation state is explicitly tied to the sole public v2 wire version. */
export const requiredProtocolVersion = protocolVersion;
