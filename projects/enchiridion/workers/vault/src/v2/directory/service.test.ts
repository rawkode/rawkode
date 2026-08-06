import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted, Ref } from "effect";
import { VaultV2Config, type VaultV2ConfigInput, makeVaultV2Config } from "../foundation/config";
import {
  InternalCapabilityFactory,
  makeInternalCapabilityFactory,
  makeVersionedIssuerHasher,
  verifiedAccessIssuer,
} from "../foundation/crypto";
import { opaqueAccessSubject, ownerID, vaultID } from "../foundation/schemas";
import { makeDirectoryInvocation } from "./gateway";
import { makeInMemoryDirectoryRepository } from "./repository";
import { makeDirectoryService } from "./service";
import type { DirectorySecureRandom, DirectoryState } from "./types";

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("test setup invalid");
  return value;
};
const secret = (value: string): Redacted.Redacted =>
  Redacted.make(`${value}-0123456789-abcdefghijklmno`);
const input: VaultV2ConfigInput = {
  access: {
    teamDomain: "team.cloudflareaccess.com",
    jwksURL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    applicationAudience: "test-audience",
    jwksCacheTTLSeconds: 60,
    jwksRefreshCooldownSeconds: 10,
    maximumAssertionLifetimeSeconds: 300,
  },
  issuerWriteKey: { keyID: "issuer-current", secret: secret("issuer-current") },
  issuerReadKeys: [
    { keyID: "issuer-current", secret: secret("issuer-current") },
    { keyID: "issuer-prior", secret: secret("issuer-prior") },
  ],
  capabilityKeys: { current: { keyID: "capability", secret: secret("capability") }, prior: [] },
  credentialQuota: 5,
};
const now = 1_760_000_000;
const random = (() => {
  let value = 0;
  return {
    identifier: (purpose: "owner" | "vault") =>
      Effect.succeed(`${purpose}-generated-${String(++value).padStart(16, "0")}`),
  };
})();

const setup = (randomSource: DirectorySecureRandom = random) =>
  Effect.gen(function* () {
    const config = yield* makeVaultV2Config(input);
    const aliases = yield* makeVersionedIssuerHasher(config.credentialBindingKeys).aliases({
      issuer: required(verifiedAccessIssuer("https://team.cloudflareaccess.com")),
      subject: required(opaqueAccessSubject("opaque-service-token-subject")),
    });
    const factory = yield* makeInternalCapabilityFactory.pipe(
      Effect.provideService(VaultV2Config, config),
    );
    const memory = yield* makeInMemoryDirectoryRepository;
    const service = yield* makeDirectoryService(randomSource).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(InternalCapabilityFactory, factory),
    );
    return { aliases, factory, memory, service };
  });

describe("v2 CredentialDirectory signed bootstrap", () => {
  test("signs clone-safe aliases, atomically bootstraps, and returns an exact replay", async () => {
    const { aliases, factory, memory, service } = await Effect.runPromise(setup());
    const invocation = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "bootstrap-request-0001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const first = await Effect.runPromise(service.resolveOrBootstrap(invocation, now));
    const replay = await Effect.runPromise(service.resolveOrBootstrap(invocation, now));
    expect(replay).toEqual(first);
    const state = await Effect.runPromise(Effect.map(memory.state, (value) => value));
    expect(JSON.stringify(state)).not.toContain("opaque-service-token-subject");
  });

  test("rejects a separately signed payload that reuses a JTI with a different fingerprint", async () => {
    const { aliases, factory, service } = await Effect.runPromise(setup());
    const first = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "replayed-request-0001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    await Effect.runPromise(service.resolveOrBootstrap(first, now));
    const config = await Effect.runPromise(makeVaultV2Config(input));
    const other = await Effect.runPromise(
      makeVersionedIssuerHasher(config.credentialBindingKeys).aliases({
        issuer: required(verifiedAccessIssuer("https://team.cloudflareaccess.com")),
        subject: required(opaqueAccessSubject("another-opaque-service-token")),
      }),
    );
    const mismatch = await Effect.runPromise(
      makeDirectoryInvocation(other, now + 90, "replayed-request-0001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const exit = await Effect.runPromiseExit(service.resolveOrBootstrap(mismatch, now));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("replay_conflict");
  });

  test("keeps expired JTIs reserved for bounded retry/skew without extending capability authorization", async () => {
    const { aliases, factory, memory, service } = await Effect.runPromise(setup());
    const delayed = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "delayed-replay-request-0001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const first = await Effect.runPromise(service.resolveOrBootstrap(delayed, now));
    expect(await Effect.runPromise(service.resolveOrBootstrap(delayed, now + 59))).toEqual(first);

    const afterExpiry = now + 61;
    const expired = await Effect.runPromiseExit(service.resolveOrBootstrap(delayed, afterExpiry));
    expect(Exit.isFailure(expired)).toBe(true);
    const fresh = await Effect.runPromise(
      makeDirectoryInvocation(
        aliases,
        afterExpiry + 90,
        "post-expiry-request-0001",
        afterExpiry,
      ).pipe(Effect.provideService(InternalCapabilityFactory, factory)),
    );
    const freshResolution = await Effect.runPromise(service.resolveOrBootstrap(fresh, afterExpiry));
    const pruned = await Effect.runPromise(Ref.get(memory.state));
    expect(pruned.replays["delayed-replay-request-0001"]?.retainUntil).toBe(now + 120);
    expect(pruned.replays["post-expiry-request-0001"]?.resolution).toEqual(freshResolution);

    const reusedWithinRetention = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 220, "delayed-replay-request-0001", afterExpiry).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const reserved = await Effect.runPromiseExit(
      service.resolveOrBootstrap(reusedWithinRetention, afterExpiry),
    );
    expect(Exit.isFailure(reserved)).toBe(true);
    expect(JSON.stringify(reserved)).toContain("replay_conflict");

    const afterRetention = now + 121;
    const reusedAfterRetention = await Effect.runPromise(
      makeDirectoryInvocation(
        aliases,
        afterRetention + 90,
        "delayed-replay-request-0001",
        afterRetention,
      ).pipe(Effect.provideService(InternalCapabilityFactory, factory)),
    );
    await Effect.runPromise(service.resolveOrBootstrap(reusedAfterRetention, afterRetention));
    expect(
      (await Effect.runPromise(Ref.get(memory.state))).replays["delayed-replay-request-0001"]
        ?.retainUntil,
    ).toBe(afterRetention + 120);

    const capacityReplays = Object.fromEntries(
      Array.from({ length: 2_048 }, (_, index) => [
        `capacity-replay-${String(index).padStart(16, "0")}`,
        {
          fingerprint: "a".repeat(64),
          expiresAt: afterExpiry + 60,
          retainUntil: afterExpiry + 120,
          resolution: freshResolution,
        },
      ]),
    );
    await Effect.runPromise(
      Ref.set(memory.state, { ...pruned, replays: capacityReplays } satisfies DirectoryState),
    );
    const atCapacity = await Effect.runPromise(
      makeDirectoryInvocation(
        aliases,
        afterExpiry + 90,
        "capacity-admit-request-01",
        afterExpiry,
      ).pipe(Effect.provideService(InternalCapabilityFactory, factory)),
    );
    const beforeCapacityFailure = JSON.stringify(await Effect.runPromise(Ref.get(memory.state)));
    const capacityExit = await Effect.runPromiseExit(
      service.resolveOrBootstrap(atCapacity, afterExpiry),
    );
    expect(Exit.isFailure(capacityExit)).toBe(true);
    expect(JSON.stringify(capacityExit)).toContain("replay_capacity");
    expect(JSON.stringify(await Effect.runPromise(Ref.get(memory.state)))).toBe(
      beforeCapacityFailure,
    );
  });

  test("rolls back random-domain failure, converges concurrent aliases, and preserves no raw Access identity", async () => {
    let failRandom = true;
    let identifier = 0;
    const flakyRandom: DirectorySecureRandom = {
      identifier: (purpose) => {
        if (failRandom) {
          failRandom = false;
          return Effect.fail({ _tag: "DirectoryRandomError" });
        }
        identifier += 1;
        return Effect.succeed(`${purpose}-retry-${String(identifier).padStart(16, "0")}`);
      },
    };
    const { aliases, factory, memory, service } = await Effect.runPromise(setup(flakyRandom));
    const retry = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "random-retry-request-0001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const failed = await Effect.runPromiseExit(service.resolveOrBootstrap(retry, now));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(JSON.stringify(failed)).toContain("random_unavailable");
    expect(await Effect.runPromise(Ref.get(memory.state))).toEqual({
      aliases: {},
      bindings: {},
      replays: {},
    });
    await Effect.runPromise(service.resolveOrBootstrap(retry, now));

    const currentOnly = {
      current: aliases.current,
      ordered: [aliases.current],
    };
    const current = await Effect.runPromise(
      makeDirectoryInvocation(currentOnly, now + 90, "concurrent-current-request-1", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const rotated = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "concurrent-rotated-request-1", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const [currentResolution, rotatedResolution] = await Effect.runPromise(
      Effect.all(
        [service.resolveOrBootstrap(current, now), service.resolveOrBootstrap(rotated, now)],
        { concurrency: "unbounded" },
      ),
    );
    expect(currentResolution.ownerID).toEqual(rotatedResolution.ownerID);
    expect(currentResolution.vaultID).toEqual(rotatedResolution.vaultID);
    const converged = await Effect.runPromise(Ref.get(memory.state));
    expect(JSON.stringify(converged)).not.toContain("opaque-service-token-subject");

    const prior = aliases.ordered[1];
    if (prior === undefined) throw new Error("test setup expected a retained prior alias");
    const conflicting: DirectoryState = {
      aliases: { [aliases.current.digest]: aliases.current.digest, [prior.digest]: prior.digest },
      bindings: {
        [aliases.current.digest]: currentResolution,
        [prior.digest]: {
          ...currentResolution,
          ownerID: required(ownerID("owner-collision-000000000001")),
          vaultID: required(vaultID("vault-collision-000000000001")),
        },
      },
      replays: {},
    };
    await Effect.runPromise(Ref.set(memory.state, conflicting));
    const collision = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "alias-collision-request-001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const beforeCollision = JSON.stringify(await Effect.runPromise(Ref.get(memory.state)));
    const collisionExit = await Effect.runPromiseExit(service.resolveOrBootstrap(collision, now));
    expect(Exit.isFailure(collisionExit)).toBe(true);
    expect(JSON.stringify(collisionExit)).toContain("repository_unavailable");
    expect(JSON.stringify(await Effect.runPromise(Ref.get(memory.state)))).toBe(beforeCollision);
  });
});
