import { Effect, Redacted } from "effect";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type {
  AccessJwksSession,
  AccessJwksSessionConfiguration,
  AccessJwtVerificationRequest,
  VerifiedAccessJwt,
} from "./access-jwt";
import {
  AccessJwtVerificationError,
  AdapterContractError,
  ExternalServiceError,
  RuntimeOperation,
  type RuntimeOperationIdentifier,
} from "./errors";

/**
 * The complete audited set of escape hatches from Effect to Cloudflare/unknown
 * values. Add an entry and a focused test before adding an adapter. Runtime and
 * worker modules may not call Promise APIs directly outside these functions.
 */
export const cloudflareAdapterLedger = [
  {
    id: "cloudflare-promise",
    boundary: "Cloudflare binding and Web Platform asynchronous APIs",
    owner: "@enchiridion/runtime",
    audit:
      "Rejected Promises discard their cause; a caller-supplied classifier alone may make them retryable.",
  },
  {
    id: "unknown-record",
    boundary: "JSON or Cloudflare unknown values before structural validation",
    owner: "@enchiridion/runtime",
    audit:
      "No unchecked cast or unknown value crosses this adapter; callers validate required fields.",
  },
  {
    id: "capability-hmac",
    boundary: "Web Crypto HMAC import/sign/verify for internal capabilities",
    owner: "@enchiridion/runtime",
    audit:
      "Redacted key material enters Web Crypto only; failures become a closed typed error upstream.",
  },
  {
    id: "p256-webcrypto",
    boundary: "Web Crypto P-256 SPKI import, ECDSA P1363 verification, and random bytes",
    owner: "@enchiridion/runtime",
    audit:
      "Only canonical validated SPKI and fixed-width P1363 signatures reach subtle.verify; platform causes and cryptographic bytes never enter diagnostics.",
  },
  {
    id: "worker-outer-boundary",
    boundary: "Effect worker handler completion to the Cloudflare Promise fetch contract",
    owner: "@enchiridion/runtime",
    audit:
      "Only a fixed safe 500 response crosses an untyped defect; no cause or request data is serialized.",
  },
  {
    id: "access-jose-jwks",
    boundary: "JOSE RemoteJWKSet and jwtVerify native Promise API for Cloudflare Access",
    owner: "@enchiridion/runtime",
    audit:
      "The adapter permits only RS256 verification against a configured HTTPS JWKS URL; all causes and token data are discarded in favour of closed safe errors.",
  },
] as const;

export type CloudflareAdapterID = (typeof cloudflareAdapterLedger)[number]["id"];

/** Bound module-global keysets so a Worker request-level Layer cannot defeat
 * JWKS caching. A forced kid-miss refresh replaces only its one issuer entry. */
const joseJwksSessions = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const maximumJoseJwksSessions = 16;

export interface PromiseRejectionClassification {
  readonly retryable: boolean;
}

export type PromiseRejectionClassifier = (cause: unknown) => PromiseRejectionClassification;

export const nonRetryableRejection: PromiseRejectionClassifier = () => ({ retryable: false });

/** The only Promise-to-Effect conversion allowed in application code. */
export const fromCloudflarePromise = <A>(
  operation: RuntimeOperationIdentifier,
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
  classifyRejection: PromiseRejectionClassifier = nonRetryableRejection,
): Effect.Effect<A, ExternalServiceError> =>
  Effect.tryPromise({
    try: (signal) => evaluate(signal),
    catch: (cause) =>
      new ExternalServiceError({ operation, retryable: classifyRejection(cause).retryable }),
  });

/** Narrows a JSON/Cloudflare unknown value to an object without an unchecked cast. */
export const unknownRecord = (
  adapter: "unknown-record",
  value: unknown,
): Effect.Effect<Record<string, unknown>, AdapterContractError> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Effect.fail(new AdapterContractError({ adapter, reason: "not_record" }));
  }
  return Effect.succeed(Object.fromEntries(Object.entries(value)));
};

const encodeText = (value: string): Uint8Array<ArrayBuffer> => {
  const source = new TextEncoder().encode(value);
  const output = new Uint8Array(source.byteLength);
  output.set(source);
  return output;
};

/** Audited Web Crypto HMAC seam for compact internal capability tokens. */
export const signCapabilityHmac = (
  secret: Redacted.Redacted,
  payload: string,
): Effect.Effect<Uint8Array<ArrayBuffer>, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.CapabilityCrypto, async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encodeText(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, encodeText(payload));
    const output = new Uint8Array(signed.byteLength);
    output.set(new Uint8Array(signed));
    return output;
  });

/** Audited Web Crypto verification seam; verification is constant-time in the platform. */
export const verifyCapabilityHmac = (
  secret: Redacted.Redacted,
  payload: string,
  signature: Uint8Array<ArrayBuffer>,
): Effect.Effect<boolean, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.CapabilityCrypto, async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encodeText(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", key, signature, encodeText(payload));
  });

/** Audited P-256 Web Crypto seam. Callers must provide already canonical SPKI and P1363 bytes. */
export const verifyP256Ecdsa = (
  canonicalSpki: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
  p1363Signature: Uint8Array<ArrayBuffer>,
): Effect.Effect<boolean, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.P256Crypto, async () => {
    const key = await crypto.subtle.importKey(
      "spki",
      canonicalSpki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, p1363Signature, message);
  });

/** Audited random boundary. The fixed-size copy prevents callers retaining a mutable platform buffer. */
export const randomP256Bytes32 = (): Effect.Effect<Uint8Array<ArrayBuffer>, ExternalServiceError> =>
  fromCloudflarePromise(RuntimeOperation.P256Crypto, async () => {
    const generated = new Uint8Array(32);
    crypto.getRandomValues(generated);
    const output = new Uint8Array(generated.byteLength);
    output.set(generated);
    return output;
  });

const accessError = (reason: AccessJwtVerificationError["reason"]): AccessJwtVerificationError =>
  new AccessJwtVerificationError({ reason });

const safeAccessClaims = (value: {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly iat?: number;
  readonly nbf?: number;
  readonly exp?: number;
  readonly sub?: string;
}): VerifiedAccessJwt["claims"] | undefined => {
  const { iss, aud, iat, nbf, exp, sub } = value;
  if (
    typeof iss !== "string" ||
    (typeof aud !== "string" &&
      (!Array.isArray(aud) || !aud.every((entry) => typeof entry === "string"))) ||
    typeof iat !== "number" ||
    typeof nbf !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(nbf) ||
    !Number.isSafeInteger(exp) ||
    typeof sub !== "string" ||
    sub.length === 0 ||
    sub.length > 512
  )
    return undefined;
  return { iss, aud, iat, nbf, exp, sub };
};

const safeAccessHeader = (value: {
  readonly alg?: string;
  readonly typ?: string;
  readonly kid?: string;
}): VerifiedAccessJwt["protectedHeader"] | undefined => {
  if (
    value.alg !== "RS256" ||
    value.typ !== "JWT" ||
    typeof value.kid !== "string" ||
    !/^[A-Za-z0-9._~-]{1,128}$/u.test(value.kid)
  )
    return undefined;
  return { alg: "RS256", typ: "JWT", kid: value.kid };
};

const joseFailure = (cause: unknown): AccessJwtVerificationError => {
  if (cause instanceof joseErrors.JWKSNoMatchingKey) return accessError("unknown_key");
  if (cause instanceof joseErrors.JWKSInvalid) return accessError("jwks_unavailable");
  if (cause instanceof joseErrors.JWSSignatureVerificationFailed)
    return accessError("signature_invalid");
  if (
    cause instanceof joseErrors.JWTClaimValidationFailed ||
    cause instanceof joseErrors.JWTExpired
  )
    return accessError("claims_invalid");
  if (cause instanceof joseErrors.JWSInvalid || cause instanceof joseErrors.JWTInvalid)
    return accessError("malformed_assertion");
  return accessError("jwks_unavailable");
};

/**
 * Sole production JOSE/JWKS seam. `jose` owns HTTP retrieval and cryptographic
 * verification; this adapter discards causes and returns only closed errors.
 */
export const makeJoseAccessJwksSession = (
  configuration: AccessJwksSessionConfiguration,
  forceRefresh: boolean,
): Effect.Effect<AccessJwksSession, AccessJwtVerificationError> =>
  Effect.try({
    try: () => {
      const existing = joseJwksSessions.get(configuration.jwksURL);
      if (forceRefresh) joseJwksSessions.delete(configuration.jwksURL);
      else if (existing !== undefined) return existing;
      if (joseJwksSessions.size >= maximumJoseJwksSessions) {
        for (const oldestURL of joseJwksSessions.keys()) {
          joseJwksSessions.delete(oldestURL);
          break;
        }
      }
      const jwks = createRemoteJWKSet(new URL(configuration.jwksURL), {
        cacheMaxAge: configuration.cacheTTLSeconds * 1_000,
        cooldownDuration: configuration.refreshCooldownSeconds * 1_000,
      });
      joseJwksSessions.set(configuration.jwksURL, jwks);
      return jwks;
    },
    catch: () => accessError("invalid_configuration"),
  }).pipe(
    Effect.map((jwks) => ({
      verify: (
        request: AccessJwtVerificationRequest,
      ): Effect.Effect<VerifiedAccessJwt, AccessJwtVerificationError> =>
        Effect.tryPromise({
          try: () =>
            jwtVerify(request.assertion, jwks, {
              algorithms: ["RS256"],
              issuer: request.issuer,
              audience: request.audience,
              currentDate: new Date(request.nowSeconds * 1_000),
            }),
          catch: joseFailure,
        }).pipe(
          Effect.flatMap(({ protectedHeader, payload }) => {
            const header = safeAccessHeader(protectedHeader);
            const claims = safeAccessClaims(payload);
            return header === undefined ||
              claims === undefined ||
              claims.iat > claims.nbf ||
              claims.nbf > claims.exp
              ? Effect.fail(accessError("claims_invalid"))
              : Effect.succeed({ protectedHeader: header, claims });
          }),
        ),
    })),
  );

export interface WorkerBoundaryContext {
  readonly waitUntil?: (work: Promise<unknown>) => void;
}

export interface WorkerBoundary {
  readonly handle: (
    request: Request,
    environment: unknown,
    context: WorkerBoundaryContext,
  ) => Promise<Response>;
}

/** The one audited Worker outer boundary. Keep all request handling in Effect. */
export const makeWorkerBoundary = (
  handler: (request: Request, environment: unknown) => Effect.Effect<Response>,
): WorkerBoundary => ({
  handle: (request, environment, _context) =>
    Effect.runPromise(
      handler(request, environment).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed(new Response(null, { status: 500, statusText: "Internal Server Error" })),
        ),
      ),
    ),
});
