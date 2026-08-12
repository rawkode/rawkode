import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted, Ref } from "effect";
import { VaultV2Config, type VaultV2ConfigInput, makeVaultV2Config } from "../foundation/config";
import {
  DirectoryControlCapabilityFactory,
  InternalCapabilityFactory,
  makeDirectoryControlCapabilityFactory,
  makeInternalCapabilityFactory,
  makeVersionedIssuerHasher,
  verifiedAccessIssuer,
} from "../foundation/crypto";
import { opaqueAccessSubject, ownerID, vaultID } from "../foundation/schemas";
import { makeDirectoryInvocation } from "./gateway";
import { type OwnerVaultInitializationCommand, OwnerVaultInitializationError } from "./lifecycle";
import { makeInMemoryDirectoryRepository } from "./repository";
import { DirectoryOwnerVaultInitializer, makeDirectoryService } from "./service";
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
const ownerVaultReceipt = "owner-vault-receipt-0001";
const random = (() => {
  let value = 0;
  return {
    identifier: (
      purpose: "owner" | "vault" | "owner-vault-initialization" | "owner-vault-floor-sync",
    ) => Effect.succeed(`${purpose}-generated-${String(++value).padStart(16, "0")}`),
  };
})();

const setup = (
  randomSource: DirectorySecureRandom = random,
  initialize: (
    command: OwnerVaultInitializationCommand,
  ) => Effect.Effect<
    OwnerVaultInitializationCommand & { readonly durableReceipt: string },
    OwnerVaultInitializationError
  > = (command) => Effect.succeed({ ...command, durableReceipt: ownerVaultReceipt }),
) =>
  Effect.gen(function* () {
    const config = yield* makeVaultV2Config(input);
    const aliases = yield* makeVersionedIssuerHasher(config.credentialBindingKeys).aliases({
      issuer: required(verifiedAccessIssuer("https://team.cloudflareaccess.com")),
      subject: required(opaqueAccessSubject("opaque-service-token-subject")),
    });
    const factory = yield* makeInternalCapabilityFactory.pipe(
      Effect.provideService(VaultV2Config, config),
    );
    const controls = yield* makeDirectoryControlCapabilityFactory.pipe(
      Effect.provideService(VaultV2Config, config),
    );
    const memory = yield* makeInMemoryDirectoryRepository;
    const service = yield* makeDirectoryService(randomSource).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(InternalCapabilityFactory, factory),
      Effect.provideService(DirectoryControlCapabilityFactory, controls),
      Effect.provideService(DirectoryOwnerVaultInitializer, {
        client: { ensureInitialized: (command) => initialize(command) },
      }),
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

  test("persists a non-routable initialization command and only activates it after an exact OwnerVault ack", async () => {
    let attempts = 0;
    const commands: Array<{ readonly operationID: string; readonly initDigest: string }> = [];
    const { aliases, factory, memory, service } = await Effect.runPromise(
      setup(random, (command) => {
        attempts += 1;
        commands.push({ operationID: command.operationID, initDigest: command.initDigest });
        return attempts === 1
          ? Effect.fail(new OwnerVaultInitializationError({ reason: "unavailable" }))
          : Effect.succeed({ ...command, durableReceipt: ownerVaultReceipt });
      }),
    );
    const invocation = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "initialization-retry-request-1", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const first = await Effect.runPromiseExit(service.resolveOrBootstrap(invocation, now));
    expect(Exit.isFailure(first)).toBe(true);
    const pending = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.values(pending.initializations)).toHaveLength(1);
    expect(Object.values(pending.initializations)[0]?.durableReceipt).toBeUndefined();
    expect(pending.replays).toEqual({});

    await Effect.runPromise(service.resolveOrBootstrap(invocation, now));
    const active = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.values(active.initializations)[0]?.durableReceipt).toBe(ownerVaultReceipt);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
  });

  test("does not reinvoke OwnerVault initialization for an activated binding", async () => {
    let calls = 0;
    const { aliases, factory, service } = await Effect.runPromise(
      setup(random, (command) => {
        calls += 1;
        return Effect.succeed({ ...command, durableReceipt: ownerVaultReceipt });
      }),
    );
    const first = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "active-init-request-0001", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    const second = await Effect.runPromise(
      makeDirectoryInvocation(aliases, now + 90, "active-init-request-0002", now).pipe(
        Effect.provideService(InternalCapabilityFactory, factory),
      ),
    );
    await Effect.runPromise(service.resolveOrBootstrap(first, now));
    await Effect.runPromise(service.resolveOrBootstrap(second, now));
    expect(calls).toBe(1);
  });

  test("rejects missing or malformed durable OwnerVault acknowledgement receipt before routing", async () => {
    for (const durableReceipt of [undefined, "short"]) {
      const { aliases, factory, memory, service } = await Effect.runPromise(
        setup(
          random,
          (command) =>
            Effect.succeed({
              ...command,
              ...(durableReceipt === undefined ? {} : { durableReceipt }),
            }) as never,
        ),
      );
      const invocation = await Effect.runPromise(
        makeDirectoryInvocation(
          aliases,
          now + 90,
          `invalid-initialization-receipt-${durableReceipt === undefined ? "missing" : "malformed"}`,
          now,
        ).pipe(Effect.provideService(InternalCapabilityFactory, factory)),
      );
      expect(
        Exit.isFailure(await Effect.runPromiseExit(service.resolveOrBootstrap(invocation, now))),
      ).toBe(true);
      const state = await Effect.runPromise(Ref.get(memory.state));
      expect(Object.values(state.initializations)[0]?.durableReceipt).toBeUndefined();
      expect(state.replays).toEqual({});
    }
  });

  test("rejects a missing or malformed initialization JTI before any durable reservation or OwnerVault RPC", async () => {
    // P05-A: the OwnerVault initialization JTI is the generated operationID.
    // A missing or malformed value must never become a durable reservation
    // and must never reach signing or the ensureInitialized RPC.
    for (const generated of ["", "malformed initialization jti"]) {
      let rpcCalls = 0;
      const malformedRandom: DirectorySecureRandom = {
        identifier: (purpose) =>
          Effect.succeed(
            purpose === "owner-vault-initialization" ? generated : `${purpose}-0123456789abcdef`,
          ),
      };
      const { aliases, factory, memory, service } = await Effect.runPromise(
        setup(malformedRandom, (command) => {
          rpcCalls += 1;
          return Effect.succeed({ ...command, durableReceipt: ownerVaultReceipt });
        }),
      );
      const invocation = await Effect.runPromise(
        makeDirectoryInvocation(
          aliases,
          now + 90,
          `malformed-init-jti-request-${String(generated.length).padStart(4, "0")}`,
          now,
        ).pipe(Effect.provideService(InternalCapabilityFactory, factory)),
      );
      const exit = await Effect.runPromiseExit(service.resolveOrBootstrap(invocation, now));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(rpcCalls).toBe(0);
      // The reservation transaction rolled back whole: no binding, alias,
      // replay, or initialization row became durable.
      expect(await Effect.runPromise(Ref.get(memory.state))).toEqual({
        aliases: {},
        bindings: {},
        replays: {},
        controlReplays: {},
        transitions: {},
        frozenBindings: {},
        retiredAliases: {},
        initializations: {},
        privateGenerations: {},
      });
    }
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

  test("permanently denies retired current and prior aliases before they can bootstrap", async () => {
    const { aliases, factory, memory, service } = await Effect.runPromise(setup());
    const retiredAliases = Object.fromEntries(
      aliases.ordered.map((alias) => [
        alias.digest,
        {
          bindingID: alias.digest,
          operationID: "retire-alias-operation-0001",
          ownerID: "owner-retired-alias-0001",
          vaultID: "vault-retired-alias-0001",
          reason: "revoke" as const,
          retiredAt: now,
          activeGeneration: 1,
          credentialEpoch: 2,
          routingEpoch: 2,
        },
      ]),
    );
    await Effect.runPromise(
      Ref.set(memory.state, {
        aliases: {},
        bindings: {},
        replays: {},
        controlReplays: {},
        transitions: {},
        frozenBindings: {},
        retiredAliases,
        initializations: {},
        privateGenerations: {},
      }),
    );
    for (const alias of aliases.ordered) {
      const currentAlias = { ...alias, current: true as const };
      const invocation = await Effect.runPromise(
        makeDirectoryInvocation(
          { current: currentAlias, ordered: [currentAlias] },
          now + 90,
          `retired-alias-request-${alias.digest.slice(-16)}`,
          now,
        ).pipe(Effect.provideService(InternalCapabilityFactory, factory)),
      );
      const denied = await Effect.runPromiseExit(service.resolveOrBootstrap(invocation, now));
      expect(Exit.isFailure(denied)).toBe(true);
      expect(JSON.stringify(denied)).toContain("capability_rejected");
    }
    expect((await Effect.runPromise(Ref.get(memory.state))).bindings).toEqual({});
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
      controlReplays: {},
      transitions: {},
      frozenBindings: {},
      retiredAliases: {},
      initializations: {},
      privateGenerations: {},
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
      controlReplays: {},
      transitions: {},
      frozenBindings: {},
      retiredAliases: {},
      initializations: {},
      privateGenerations: {},
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
