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
import { opaqueAccessSubject } from "../foundation/schemas";
import { makeDirectoryInvocation } from "./gateway";
import {
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationCommand,
  floorSyncDigest,
  initializationDigest,
} from "./lifecycle";
import {
  DirectoryOwnerVaultPrivateGeneration,
  makeDirectoryPrivateGenerationService,
} from "./private-generation";
import { DirectoryRepository, makeInMemoryDirectoryRepository } from "./repository";
import { DirectoryOwnerVaultInitializer, makeDirectoryService } from "./service";
import type { DirectorySecureRandom } from "./types";

const secret = (value: string): Redacted.Redacted =>
  Redacted.make(`${value}-0123456789-abcdefghijklmno`);
const configInput: VaultV2ConfigInput = {
  access: {
    teamDomain: "team.cloudflareaccess.com",
    jwksURL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    applicationAudience: "test-audience",
    jwksCacheTTLSeconds: 60,
    jwksRefreshCooldownSeconds: 10,
    maximumAssertionLifetimeSeconds: 300,
  },
  issuerWriteKey: { keyID: "issuer-current", secret: secret("issuer-current") },
  issuerReadKeys: [{ keyID: "issuer-current", secret: secret("issuer-current") }],
  capabilityKeys: { current: { keyID: "capability", secret: secret("capability") }, prior: [] },
  credentialQuota: 5,
};
const now = 1_760_000_000;
const receipt = "private-generation-receipt-0001";

const random = (): DirectorySecureRandom => {
  let next = 0;
  return {
    identifier: (purpose) =>
      Effect.succeed(`${purpose}-generated-${String(++next).padStart(16, "0")}`),
  };
};

const setup = () =>
  Effect.gen(function* () {
    const config = yield* makeVaultV2Config(configInput);
    const issuer = verifiedAccessIssuer("https://team.cloudflareaccess.com");
    if (issuer === undefined) throw new Error("test issuer setup failed");
    const subject = opaqueAccessSubject("private-generation-subject");
    if (subject === undefined) throw new Error("test subject setup failed");
    const aliases = yield* makeVersionedIssuerHasher(config.credentialBindingKeys).aliases({
      issuer,
      subject,
    });
    const capabilities = yield* makeInternalCapabilityFactory.pipe(
      Effect.provideService(VaultV2Config, config),
    );
    const controls = yield* makeDirectoryControlCapabilityFactory.pipe(
      Effect.provideService(VaultV2Config, config),
    );
    const memory = yield* makeInMemoryDirectoryRepository;
    const entropy = random();
    const bootstrap = yield* makeDirectoryService(entropy).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(InternalCapabilityFactory, capabilities),
      Effect.provideService(DirectoryControlCapabilityFactory, controls),
      Effect.provideService(DirectoryOwnerVaultInitializer, {
        client: {
          ensureInitialized: (command) => Effect.succeed({ ...command, durableReceipt: receipt }),
        },
      }),
    );
    const invocation = yield* makeDirectoryInvocation(
      aliases,
      now + 60,
      "private-generation-bootstrap",
      now,
    ).pipe(Effect.provideService(InternalCapabilityFactory, capabilities));
    const source = yield* bootstrap.resolveOrBootstrap(invocation, now);
    return { controls, entropy, memory, source };
  });

describe("Directory private generation contract", () => {
  test("allocates only a fresh target root, binds all floors, and never routes it", async () => {
    const { controls, entropy, memory, source } = await Effect.runPromise(setup());
    const commands: OwnerVaultInitializationCommand[] = [];
    const service = await Effect.runPromise(
      makeDirectoryPrivateGenerationService(entropy).pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryControlCapabilityFactory, controls),
        Effect.provideService(DirectoryOwnerVaultPrivateGeneration, {
          initialization: {
            ensureInitialized: (command) => {
              commands.push(command);
              return Effect.succeed({ ...command, durableReceipt: receipt });
            },
          },
          floors: { syncFloors: () => Effect.die("floor sync should not be called") },
        }),
      ),
    );
    const target = await Effect.runPromise(
      service.prepare(
        {
          ownerID: source.ownerID.value,
          vaultID: source.vaultID.value,
          generationEpoch: source.activeGeneration,
        },
        "private-generation-operation-0001",
        now,
      ),
    );
    expect(target.phase).toBe("PRIVATE_READY");
    expect(target.generationEpoch).toBe(source.activeGeneration + 1);
    expect(target.ownerID).toBe(source.ownerID.value);
    expect(target.vaultID).toBe(source.vaultID.value);
    expect(commands).toHaveLength(1);
    const initializationCommand = commands[0];
    if (initializationCommand === undefined) throw new Error("test initialization setup failed");
    expect(initializationCommand.credentialEpoch).toBe(source.credentialEpoch);
    expect(initializationCommand.routingEpoch).toBe(source.routingEpoch);
    expect(initializationCommand.controlEpoch).toBe(source.controlEpoch);
    expect(commands[0]?.initDigest).toBe(
      initializationDigest({
        ownerID: target.ownerID,
        vaultID: target.vaultID,
        generationEpoch: target.generationEpoch,
        operationID: initializationCommand.operationID,
        credentialEpoch: target.credentialEpoch,
        routingEpoch: target.routingEpoch,
        controlEpoch: target.controlEpoch,
      }),
    );
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.values(state.bindings)).toHaveLength(1);
    expect(Object.values(state.bindings)[0]?.activeGeneration).toBe(source.activeGeneration);
    expect(state.privateGenerations[target.operationID]).toEqual(target);
    const before = JSON.stringify(state.privateGenerations);
    const forgedSource = await Effect.runPromiseExit(
      service.prepare(
        {
          ownerID: source.ownerID.value,
          vaultID: source.vaultID.value,
          generationEpoch: target.generationEpoch,
        },
        "private-generation-forged-source",
        now,
      ),
    );
    expect(forgedSource._tag).toBe("Failure");
    expect(
      JSON.stringify((await Effect.runPromise(Ref.get(memory.state))).privateGenerations),
    ).toBe(before);
  });

  test("re-reads floors after init acknowledgement, syncs forward exactly, and leaves stale init private", async () => {
    const { controls, entropy, memory, source } = await Effect.runPromise(setup());
    const syncs: OwnerVaultFloorSyncCommand[] = [];
    const service = await Effect.runPromise(
      makeDirectoryPrivateGenerationService(entropy).pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryControlCapabilityFactory, controls),
        Effect.provideService(DirectoryOwnerVaultPrivateGeneration, {
          initialization: {
            ensureInitialized: (command) =>
              Ref.update(memory.state, (state) => ({
                ...state,
                replays: {},
                bindings: Object.fromEntries(
                  Object.entries(state.bindings).map(([binding, value]) => [
                    binding,
                    {
                      ...value,
                      credentialEpoch: 2,
                      routingEpoch: 2,
                      controlEpoch: 2,
                    },
                  ]),
                ),
              })).pipe(Effect.as({ ...command, durableReceipt: receipt })),
          },
          floors: {
            syncFloors: (command) => {
              syncs.push(command);
              return Effect.succeed({
                ...command,
                durableReceipt: "private-floor-sync-receipt-0001",
              });
            },
          },
        }),
      ),
    );
    const target = await Effect.runPromise(
      service.prepare(
        {
          ownerID: source.ownerID.value,
          vaultID: source.vaultID.value,
          generationEpoch: source.activeGeneration,
        },
        "private-generation-race-operation",
        now,
      ),
    );
    expect(target.phase).toBe("PRIVATE_READY");
    expect(target.initialization.credentialEpoch).toBe(1);
    expect(target.credentialEpoch).toBe(2);
    expect(target.routingEpoch).toBe(2);
    expect(target.controlEpoch).toBe(2);
    expect(syncs).toHaveLength(1);
    const floorSyncCommand = syncs[0];
    if (floorSyncCommand === undefined) throw new Error("test floor sync setup failed");
    expect(syncs[0]?.floorSyncDigest).toBe(
      floorSyncDigest({
        ownerID: target.ownerID,
        vaultID: target.vaultID,
        generationEpoch: target.generationEpoch,
        operationID: floorSyncCommand.operationID,
        credentialEpoch: 2,
        routingEpoch: 2,
        controlEpoch: 2,
      }),
    );
    expect(target.floorSync?.durableReceipt).toBe("private-floor-sync-receipt-0001");
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.values(state.bindings)[0]?.activeGeneration).toBe(source.activeGeneration);
    expect(Object.values(state.privateGenerations)[0]?.phase).toBe("PRIVATE_READY");
  });

  test("rejects a missing or malformed operation before any reservation transaction or OwnerVault RPC", async () => {
    // P05-A: the malformed caller operation must be rejected before the
    // Directory opens its reservation transaction and before OwnerVault is
    // signed for or invoked.
    const { controls, entropy, memory, source } = await Effect.runPromise(setup());
    let transactions = 0;
    let rpcCalls = 0;
    const counting: DirectoryRepository = {
      transact: (operation) => {
        transactions += 1;
        return memory.repository.transact(operation);
      },
    };
    const service = await Effect.runPromise(
      makeDirectoryPrivateGenerationService(entropy).pipe(
        Effect.provideService(DirectoryRepository, counting),
        Effect.provideService(DirectoryControlCapabilityFactory, controls),
        Effect.provideService(DirectoryOwnerVaultPrivateGeneration, {
          initialization: {
            ensureInitialized: (command) => {
              rpcCalls += 1;
              return Effect.succeed({ ...command, durableReceipt: receipt });
            },
          },
          floors: { syncFloors: () => Effect.die("floor sync must not be reached") },
        }),
      ),
    );
    for (const operation of ["", "short", "private generation operation!"]) {
      const exit = await Effect.runPromiseExit(
        service.prepare(
          {
            ownerID: source.ownerID.value,
            vaultID: source.vaultID.value,
            generationEpoch: source.activeGeneration,
          },
          operation,
          now,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid_source");
    }
    expect(transactions).toBe(0);
    expect(rpcCalls).toBe(0);
  });

  test("rejects a malformed generated initialization JTI before a durable reservation or the RPC", async () => {
    // The generated initialization operationID is the OwnerVault capability
    // JTI. When it is malformed the reservation transaction must roll back
    // whole and ensureInitialized must never run.
    const { controls, memory, source } = await Effect.runPromise(setup());
    let rpcCalls = 0;
    const malformedEntropy: DirectorySecureRandom = {
      identifier: () => Effect.succeed("bad jti"),
    };
    const service = await Effect.runPromise(
      makeDirectoryPrivateGenerationService(malformedEntropy).pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryControlCapabilityFactory, controls),
        Effect.provideService(DirectoryOwnerVaultPrivateGeneration, {
          initialization: {
            ensureInitialized: (command) => {
              rpcCalls += 1;
              return Effect.succeed({ ...command, durableReceipt: receipt });
            },
          },
          floors: { syncFloors: () => Effect.die("floor sync must not be reached") },
        }),
      ),
    );
    const before = JSON.stringify(await Effect.runPromise(Ref.get(memory.state)));
    const exit = await Effect.runPromiseExit(
      service.prepare(
        {
          ownerID: source.ownerID.value,
          vaultID: source.vaultID.value,
          generationEpoch: source.activeGeneration,
        },
        "private-generation-malformed-jti",
        now,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(rpcCalls).toBe(0);
    expect(JSON.stringify(await Effect.runPromise(Ref.get(memory.state)))).toBe(before);
    expect(
      (await Effect.runPromise(Ref.get(memory.state))).privateGenerations[
        "private-generation-malformed-jti"
      ],
    ).toBeUndefined();
  });
});
