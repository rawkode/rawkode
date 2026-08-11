import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import {
  type AccessJwksSession,
  type AccessJwksSessionFactory,
  type AccessJwtVerificationRequest,
  type VerifiedAccessJwt,
  makeAccessJwtVerifier,
} from "./access-jwt";
import { AccessJwtVerificationError } from "./errors";

const configuration = {
  jwksURL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  cacheTTLSeconds: 30,
  refreshCooldownSeconds: 10,
};

const request: AccessJwtVerificationRequest = {
  assertion: "header.payload.signature",
  issuer: "https://team.cloudflareaccess.com",
  audience: "access-audience",
  nowSeconds: 1_760_000_000,
};

const verified: VerifiedAccessJwt = {
  protectedHeader: { alg: "RS256", typ: "JWT", kid: "key-1" },
  claims: {
    iss: request.issuer,
    aud: request.audience,
    iat: request.nowSeconds - 10,
    nbf: request.nowSeconds - 5,
    exp: request.nowSeconds + 60,
    sub: "opaque-device-subject",
  },
};

const session = (
  result: Effect.Effect<VerifiedAccessJwt, AccessJwtVerificationError>,
): AccessJwksSession => ({ verify: () => result });

describe("Access JWT runtime service", () => {
  test("singleflights concurrent cache misses and reuses the bounded session", async () => {
    const creations = await Effect.runPromise(Ref.make(0));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const factory: AccessJwksSessionFactory = () =>
      Effect.gen(function* () {
        yield* Ref.update(creations, (value) => value + 1);
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return session(Effect.succeed(verified));
      });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const verifier = yield* makeAccessJwtVerifier(configuration, factory);
        const fiber = yield* Effect.all([verifier.verify(request), verifier.verify(request)], {
          concurrency: "unbounded",
        }).pipe(Effect.fork);
        yield* Deferred.await(entered);
        expect(yield* Ref.get(creations)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(result).toEqual([verified, verified]);
    expect(await Effect.runPromise(Ref.get(creations))).toBe(1);
  });

  test("rotates exactly once after a kid miss and then enforces cooldown", async () => {
    const creations = await Effect.runPromise(Ref.make(0));
    const factory: AccessJwksSessionFactory = () =>
      Effect.flatMap(
        Ref.updateAndGet(creations, (value) => value + 1),
        (count) =>
          Effect.succeed(
            session(
              count === 1
                ? Effect.fail(new AccessJwtVerificationError({ reason: "unknown_key" }))
                : Effect.succeed(verified),
            ),
          ),
      );
    const verifier = await Effect.runPromise(makeAccessJwtVerifier(configuration, factory));
    expect(await Effect.runPromise(verifier.verify(request))).toEqual(verified);
    expect(await Effect.runPromise(Ref.get(creations))).toBe(2);
  });

  test("concurrent peers of one stale session share its kid-miss replacement", async () => {
    const creations = await Effect.runPromise(Ref.make(0));
    const staleVerifications = await Effect.runPromise(Ref.make(0));
    const bothStale = await Effect.runPromise(Deferred.make<void>());
    const releaseStale = await Effect.runPromise(Deferred.make<void>());
    const staleSession: AccessJwksSession = {
      verify: () =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(staleVerifications, (value) => value + 1);
          if (count === 2) yield* Deferred.succeed(bothStale, undefined);
          yield* Deferred.await(releaseStale);
          return yield* Effect.fail(new AccessJwtVerificationError({ reason: "unknown_key" }));
        }),
    };
    const factory: AccessJwksSessionFactory = () =>
      Effect.flatMap(
        Ref.updateAndGet(creations, (value) => value + 1),
        (count) => Effect.succeed(count === 1 ? staleSession : session(Effect.succeed(verified))),
      );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const verifier = yield* makeAccessJwtVerifier(configuration, factory);
        const peers = yield* Effect.all([verifier.verify(request), verifier.verify(request)], {
          concurrency: "unbounded",
        }).pipe(Effect.fork);
        yield* Deferred.await(bothStale);
        yield* Deferred.succeed(releaseStale, undefined);
        return yield* Fiber.join(peers);
      }),
    );
    expect(result).toEqual([verified, verified]);
    expect(await Effect.runPromise(Ref.get(creations))).toBe(2);
  });

  test("does not repeatedly refresh a rotating unknown kid during cooldown", async () => {
    const creations = await Effect.runPromise(Ref.make(0));
    const factory: AccessJwksSessionFactory = () =>
      Effect.flatMap(
        Ref.updateAndGet(creations, (value) => value + 1),
        () =>
          Effect.succeed(
            session(Effect.fail(new AccessJwtVerificationError({ reason: "unknown_key" }))),
          ),
      );
    const verifier = await Effect.runPromise(makeAccessJwtVerifier(configuration, factory));
    const first = await Effect.runPromiseExit(verifier.verify(request));
    expect(Exit.isFailure(first)).toBe(true);
    expect(await Effect.runPromise(Ref.get(creations))).toBe(2);
    const second = await Effect.runPromiseExit(verifier.verify(request));
    expect(Exit.isFailure(second)).toBe(true);
    expect(JSON.stringify(second)).toContain("refresh_cooldown");
    expect(await Effect.runPromise(Ref.get(creations))).toBe(2);
  });

  test("fails closed for JWKS outage, oversized assertions, and invalid clocks without exposing input", async () => {
    const secretBearingAssertion = `secret-token-${"x".repeat(8_200)}`;
    const outage: AccessJwksSessionFactory = () =>
      Effect.fail(new AccessJwtVerificationError({ reason: "jwks_unavailable" }));
    const verifier = await Effect.runPromise(makeAccessJwtVerifier(configuration, outage));
    const outageExit = await Effect.runPromiseExit(verifier.verify(request));
    expect(Exit.isFailure(outageExit)).toBe(true);
    expect(JSON.stringify(outageExit)).not.toContain(request.assertion);
    const sizeExit = await Effect.runPromiseExit(
      verifier.verify({ ...request, assertion: secretBearingAssertion }),
    );
    expect(Exit.isFailure(sizeExit)).toBe(true);
    expect(JSON.stringify(sizeExit)).not.toContain(secretBearingAssertion);
    const clockExit = await Effect.runPromiseExit(
      verifier.verify({ ...request, nowSeconds: Number.NaN }),
    );
    expect(Exit.isFailure(clockExit)).toBe(true);
  });
});
