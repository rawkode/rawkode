import { describe, expect, test } from "bun:test";
import { Effect, Redacted, Ref } from "effect";
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
  floorSyncDigest,
  initializationDigest,
  type OwnerVaultFloorSyncCommand,
  type OwnerVaultInitializationCommand,
} from "./lifecycle";
import {
  DirectoryOwnerVaultPrivateGeneration,
  makeDirectoryPrivateGenerationService,
} from "./private-generation";
import { makeInMemoryDirectoryRepository } from "./repository";
import { DirectoryOwnerVaultInitializer, makeDirectoryService } from "./service";
import type { DirectorySecureRandom } from "./types";

const secret = (value: string): Redacted.Redacted => Redacted.make(`${value}-0123456789-abcdefghijklmno`);
const configInput: VaultV2ConfigInput = {
  access: {
    teamDomain: "team.cloudflareaccess.com", jwksURL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    applicationAudience: "test-audience", jwksCacheTTLSeconds: 60, jwksRefreshCooldownSeconds: 10,
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
    identifier: (purpose) => Effect.succeed(`${purpose}-generated-${String(++next).padStart(16, "0")}`),
  };
};

const setup = () => Effect.gen(function* () {
  const config = yield* makeVaultV2Config(configInput);
  const aliases = yield* makeVersionedIssuerHasher(config.credentialBindingKeys).aliases({
    issuer: verifiedAccessIssuer("https://team.cloudflareaccess.com")!,
    subject: opaqueAccessSubject("private-generation-subject")!,
  });
  const capabilities = yield* makeInternalCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config));
  const controls = yield* makeDirectoryControlCapabilityFactory.pipe(Effect.provideService(VaultV2Config, config));
  const memory = yield* makeInMemoryDirectoryRepository;
  const entropy = random();
  const bootstrap = yield* makeDirectoryService(entropy).pipe(
    Effect.provide(memory.layer),
    Effect.provideService(InternalCapabilityFactory, capabilities),
    Effect.provideService(DirectoryControlCapabilityFactory, controls),
    Effect.provideService(DirectoryOwnerVaultInitializer, {
      client: { ensureInitialized: (command) => Effect.succeed({ ...command, durableReceipt: receipt }) },
    }),
  );
  const invocation = yield* makeDirectoryInvocation(aliases, now + 60, "private-generation-bootstrap", now).pipe(
    Effect.provideService(InternalCapabilityFactory, capabilities),
  );
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
    const target = await Effect.runPromise(service.prepare({
      ownerID: source.ownerID.value, vaultID: source.vaultID.value, generationEpoch: source.activeGeneration,
    }, "private-generation-operation-0001", now));
    expect(target.phase).toBe("PRIVATE_READY");
    expect(target.generationEpoch).toBe(source.activeGeneration + 1);
    expect(target.ownerID).toBe(source.ownerID.value);
    expect(target.vaultID).toBe(source.vaultID.value);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.credentialEpoch).toBe(source.credentialEpoch);
    expect(commands[0]?.routingEpoch).toBe(source.routingEpoch);
    expect(commands[0]?.controlEpoch).toBe(source.controlEpoch);
    expect(commands[0]?.initDigest).toBe(initializationDigest({
      ownerID: target.ownerID, vaultID: target.vaultID, generationEpoch: target.generationEpoch,
      operationID: commands[0]!.operationID, credentialEpoch: target.credentialEpoch,
      routingEpoch: target.routingEpoch, controlEpoch: target.controlEpoch,
    }));
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.values(state.bindings)).toHaveLength(1);
    expect(Object.values(state.bindings)[0]?.activeGeneration).toBe(source.activeGeneration);
    expect(state.privateGenerations[target.operationID]).toEqual(target);
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
                bindings: Object.fromEntries(Object.entries(state.bindings).map(([binding, value]) => [binding, {
                  ...value, credentialEpoch: 2, routingEpoch: 2, controlEpoch: 2,
                }])),
              })).pipe(Effect.as({ ...command, durableReceipt: receipt })),
          },
          floors: {
            syncFloors: (command) => {
              syncs.push(command);
              return Effect.succeed({ ...command, durableReceipt: "private-floor-sync-receipt-0001" });
            },
          },
        }),
      ),
    );
    const target = await Effect.runPromise(service.prepare({
      ownerID: source.ownerID.value, vaultID: source.vaultID.value, generationEpoch: source.activeGeneration,
    }, "private-generation-race-operation", now));
    expect(target.phase).toBe("PRIVATE_READY");
    expect(target.initialization.credentialEpoch).toBe(1);
    expect(target.credentialEpoch).toBe(2);
    expect(target.routingEpoch).toBe(2);
    expect(target.controlEpoch).toBe(2);
    expect(syncs).toHaveLength(1);
    expect(syncs[0]?.floorSyncDigest).toBe(floorSyncDigest({
      ownerID: target.ownerID, vaultID: target.vaultID, generationEpoch: target.generationEpoch,
      operationID: syncs[0]!.operationID, credentialEpoch: 2, routingEpoch: 2, controlEpoch: 2,
    }));
    expect(target.floorSync?.durableReceipt).toBe("private-floor-sync-receipt-0001");
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.values(state.bindings)[0]?.activeGeneration).toBe(source.activeGeneration);
    expect(Object.values(state.privateGenerations)[0]?.phase).toBe("PRIVATE_READY");
  });
});
