import { Context, Effect, Layer, Ref } from "effect";
import { makeJoseAccessJwksSession } from "./adapters";
import { AccessJwtVerificationError } from "./errors";

export interface AccessJwksSessionConfiguration {
  readonly jwksURL: string;
  readonly cacheTTLSeconds: number;
  readonly refreshCooldownSeconds: number;
}

export interface AccessJwtVerificationRequest {
  readonly assertion: string;
  readonly issuer: string;
  readonly audience: string;
  /** A caller-provided, finite SafeInteger Unix timestamp makes time testable. */
  readonly nowSeconds: number;
}

export interface VerifiedAccessJwt {
  readonly protectedHeader: {
    readonly alg: "RS256";
    readonly typ: "JWT";
    readonly kid: string;
  };
  readonly claims: {
    readonly iss: string;
    readonly aud: string | readonly string[];
    readonly iat: number;
    readonly nbf: number;
    readonly exp: number;
    readonly sub: string;
  };
}

export interface AccessJwksSession {
  readonly verify: (
    request: AccessJwtVerificationRequest,
  ) => Effect.Effect<VerifiedAccessJwt, AccessJwtVerificationError>;
}

/** Testable constructor boundary; production uses the audited JOSE implementation. */
export type AccessJwksSessionFactory = (
  configuration: AccessJwksSessionConfiguration,
  forceRefresh: boolean,
) => Effect.Effect<AccessJwksSession, AccessJwtVerificationError>;

export interface AccessJwtVerifier {
  readonly verify: (
    request: AccessJwtVerificationRequest,
  ) => Effect.Effect<VerifiedAccessJwt, AccessJwtVerificationError>;
}

export const AccessJwtVerifier = Context.GenericTag<AccessJwtVerifier>(
  "@enchiridion/runtime/AccessJwtVerifier",
);

interface CachedSession {
  readonly session: AccessJwksSession;
  readonly expiresAtSeconds: number;
  /** A kid-miss refresh, distinct from normal cache construction/expiry. */
  readonly kidMissRefreshedAtSeconds?: number;
}

const assertionMaximumLength = 8_192;

const safeTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validIssuer = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
};

const validConfiguration = (configuration: AccessJwksSessionConfiguration): boolean => {
  try {
    const url = new URL(configuration.jwksURL);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      Number.isSafeInteger(configuration.cacheTTLSeconds) &&
      configuration.cacheTTLSeconds >= 1 &&
      configuration.cacheTTLSeconds <= 3_600 &&
      Number.isSafeInteger(configuration.refreshCooldownSeconds) &&
      configuration.refreshCooldownSeconds >= 1 &&
      configuration.refreshCooldownSeconds <= 3_600
    );
  } catch {
    return false;
  }
};

const failure = <A>(
  reason: AccessJwtVerificationError["reason"],
): Effect.Effect<A, AccessJwtVerificationError> =>
  Effect.fail(new AccessJwtVerificationError({ reason }));

/**
 * A single bounded issuer/JWKS cache. The semaphore is a singleflight: all
 * concurrent cache misses wait for one session construction. A verified kid
 * miss is permitted one replacement session per configured cooldown.
 */
export const makeAccessJwtVerifier = (
  configuration: AccessJwksSessionConfiguration,
  createSession: AccessJwksSessionFactory = makeJoseAccessJwksSession,
): Effect.Effect<AccessJwtVerifier, AccessJwtVerificationError> => {
  if (!validConfiguration(configuration)) return failure("invalid_configuration");
  return Effect.gen(function* () {
    const cache = yield* Ref.make<CachedSession | undefined>(undefined);
    const singleflight = yield* Effect.makeSemaphore(1);
    const load = (
      nowSeconds: number,
      force: boolean,
    ): Effect.Effect<AccessJwksSession, AccessJwtVerificationError> =>
      singleflight.withPermits(1)(
        Effect.flatMap(Ref.get(cache), (cached) => {
          const usable = cached !== undefined && cached.expiresAtSeconds > nowSeconds;
          if (!force && usable) return Effect.succeed(cached.session);
          if (
            force &&
            cached !== undefined &&
            cached.kidMissRefreshedAtSeconds !== undefined &&
            nowSeconds - cached.kidMissRefreshedAtSeconds < configuration.refreshCooldownSeconds
          )
            return failure("refresh_cooldown");
          return Effect.tap(createSession(configuration, force), (session) =>
            Ref.set(cache, {
              session,
              expiresAtSeconds: nowSeconds + configuration.cacheTTLSeconds,
              kidMissRefreshedAtSeconds: force ? nowSeconds : cached?.kidMissRefreshedAtSeconds,
            }),
          );
        }),
      );

    return {
      verify: (request) => {
        if (!safeTime(request.nowSeconds)) return failure("invalid_time");
        if (!validIssuer(request.issuer) || request.audience.length === 0)
          return failure("invalid_configuration");
        if (request.assertion.length === 0 || request.assertion.length > assertionMaximumLength)
          return failure("malformed_assertion");
        return Effect.flatMap(load(request.nowSeconds, false), (session) =>
          session
            .verify(request)
            .pipe(
              Effect.catchTag("AccessJwtVerificationError", (error) =>
                error.reason === "unknown_key"
                  ? Effect.flatMap(load(request.nowSeconds, true), (rotated) =>
                      rotated.verify(request),
                    )
                  : Effect.fail(error),
              ),
            ),
        );
      },
    } satisfies AccessJwtVerifier;
  });
};

export const layerAccessJwtVerifier = (
  configuration: AccessJwksSessionConfiguration,
): Layer.Layer<AccessJwtVerifier, AccessJwtVerificationError> =>
  Layer.effect(AccessJwtVerifier, makeAccessJwtVerifier(configuration));
