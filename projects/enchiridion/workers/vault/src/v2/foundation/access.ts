/** @enchiridion/effect-module */
import {
  type AccessJwtVerificationError,
  AccessJwtVerifier as RuntimeAccessJwtVerifier,
  type VerifiedAccessJwt,
} from "@enchiridion/runtime";
import { Context, Data, Effect, Layer } from "effect";
import { VaultV2Config } from "./config";
import { type VerifiedAccessIssuer, verifiedAccessIssuer } from "./crypto";
import { VaultV2Metrics } from "./metrics";
import {
  type AccessClaims,
  type AccessProtectedHeader,
  accessClaims,
  accessProtectedHeader,
  hasAudience,
  validAccessTimes,
} from "./schemas";

export class AccessAssertionError extends Data.TaggedError("AccessAssertionError")<{
  readonly reason:
    | "missing_assertion"
    | "malformed_assertion"
    | "protected_header_invalid"
    | "signature_invalid"
    | "unknown_key"
    | "jwks_unavailable"
    | "claims_invalid";
}> {}

/** The Managed OAuth client credential never reaches origin; only this Access-issued JWT does. */
export const cfAccessJwtAssertionHeaderName = "Cf-Access-Jwt-Assertion";
export const maximumAccessAssertionLength = 8_192;

export interface AccessAssertionHeaderValues {
  readonly values: (name: typeof cfAccessJwtAssertionHeaderName) => readonly string[];
}

/** Route adapter bridge: a comma-combined value is never a valid singular JWT header. */
export const accessAssertionHeadersFromWorkerHeaders = (
  headers: Headers,
): AccessAssertionHeaderValues => ({
  values: () => {
    const value = headers.get(cfAccessJwtAssertionHeaderName);
    return value === null || value.includes(",") ? [] : [value];
  },
});

export interface VerifiedAccessAssertion {
  readonly issuer: VerifiedAccessIssuer;
  readonly subject: AccessClaims["sub"];
  readonly protectedHeader: AccessProtectedHeader;
  readonly claims: Omit<AccessClaims, "sub">;
}

export interface AccessAssertionVerifier {
  readonly verify: (
    headers: AccessAssertionHeaderValues,
    nowSeconds: number,
  ) => Effect.Effect<VerifiedAccessAssertion, AccessAssertionError>;
}

export const AccessAssertionVerifier = Context.GenericTag<AccessAssertionVerifier>(
  "@enchiridion/worker-vault/v2/AccessAssertionVerifier",
);

export const normalizedAccessTeamDomain = (value: string): string | undefined => {
  const host = value
    .trim()
    .replace(/^https:\/\//u, "")
    .replace(/\/+$/u, "");
  if (!/^[a-z0-9.-]+$/u.test(host) || host.length === 0) return undefined;
  return host.includes(".") ? host : `${host}.cloudflareaccess.com`;
};

export const cloudflareAccessJwksURL = (teamDomain: string): string =>
  `https://${teamDomain}/cdn-cgi/access/certs`;

const headerJSON = (assertion: string): unknown | undefined => {
  const part = assertion.split(".")[0];
  if (part === undefined || assertion.split(".").length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(part))
    return undefined;
  try {
    const padded = `${part.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (part.length % 4)) % 4)}`;
    return JSON.parse(atob(padded));
  } catch {
    return undefined;
  }
};

const failure = <A>(
  reason: AccessAssertionError["reason"],
): Effect.Effect<A, AccessAssertionError> => Effect.fail(new AccessAssertionError({ reason }));

const fromRuntimeFailure = (error: AccessJwtVerificationError): AccessAssertionError =>
  new AccessAssertionError({
    reason:
      error.reason === "unknown_key"
        ? "unknown_key"
        : error.reason === "jwks_unavailable" || error.reason === "refresh_cooldown"
          ? "jwks_unavailable"
          : error.reason === "malformed_assertion"
            ? "malformed_assertion"
            : error.reason === "claims_invalid" ||
                error.reason === "invalid_configuration" ||
                error.reason === "invalid_time"
              ? "claims_invalid"
              : "signature_invalid",
  });

/**
 * Effect-only origin assertion service. The audited runtime verifier owns the
 * JOSE/JWKS cache and rotation; this layer owns strict ingress/post-validation
 * and safe telemetry.
 */
export const makeAccessAssertionVerifier = Effect.gen(function* () {
  const config = yield* VaultV2Config;
  const runtimeVerifier = yield* RuntimeAccessJwtVerifier;
  const metrics = yield* VaultV2Metrics;
  const teamDomain = normalizedAccessTeamDomain(config.access.teamDomain);
  if (teamDomain === undefined) return yield* failure<AccessAssertionVerifier>("claims_invalid");
  const issuer = `https://${teamDomain}`;
  const verifyWith = (
    assertion: string,
    nowSeconds: number,
  ): Effect.Effect<VerifiedAccessAssertion, AccessAssertionError> =>
    Effect.flatMap(
      runtimeVerifier.verify({
        assertion,
        issuer,
        audience: config.access.applicationAudience,
        nowSeconds,
      }),
      (verified: VerifiedAccessJwt) => {
        const protectedHeader = accessProtectedHeader(verified.protectedHeader);
        const claims = accessClaims(verified.claims);
        const normalizedIssuer =
          claims === undefined ? undefined : verifiedAccessIssuer(claims.iss);
        if (protectedHeader === undefined)
          return failure<VerifiedAccessAssertion>("protected_header_invalid");
        if (
          claims === undefined ||
          normalizedIssuer === undefined ||
          claims.iss !== issuer ||
          !hasAudience(claims, config.access.applicationAudience) ||
          !validAccessTimes(claims, nowSeconds) ||
          claims.exp - claims.iat > config.access.maximumAssertionLifetimeSeconds
        )
          return failure<VerifiedAccessAssertion>("claims_invalid");
        return Effect.succeed({
          issuer: normalizedIssuer,
          subject: claims.sub,
          protectedHeader,
          claims: {
            iss: claims.iss,
            aud: claims.aud,
            iat: claims.iat,
            nbf: claims.nbf,
            exp: claims.exp,
          },
        });
      },
    ).pipe(
      Effect.mapError((error) =>
        error instanceof AccessAssertionError ? error : fromRuntimeFailure(error),
      ),
    );

  const verifier: AccessAssertionVerifier = {
    verify: (headers, nowSeconds) => {
      const values = headers.values(cfAccessJwtAssertionHeaderName);
      const assertion = values[0];
      if (
        assertion === undefined ||
        values.length !== 1 ||
        assertion.length === 0 ||
        assertion.length > maximumAccessAssertionLength
      )
        return failure("missing_assertion");
      if (accessProtectedHeader(headerJSON(assertion)) === undefined)
        return failure("protected_header_invalid");
      return verifyWith(assertion, nowSeconds).pipe(
        Effect.tap(() => metrics.increment("access.accepted")),
        Effect.tapError(() => metrics.increment("access.rejected")),
      );
    },
  };
  return verifier;
});

export const layerAccessAssertionVerifier = Layer.effect(
  AccessAssertionVerifier,
  makeAccessAssertionVerifier,
);
