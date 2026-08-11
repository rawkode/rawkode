import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@enchiridion/protocol";
import {
  CapabilityAudience,
  CapabilityAuthority,
  CapabilityMethod,
  DirectoryControlCapabilityAudience,
  DirectoryControlCapabilityAuthority,
  type DirectoryControlCapabilityClaims,
  DirectoryControlResource,
  makeCapabilitySigner,
  makeDirectoryControlCapabilitySigner,
  makeDirectoryControlCapabilityVerifier,
  signCapabilityHmac,
} from "@enchiridion/runtime";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit, Redacted, Ref } from "effect";
import {
  DirectoryControlCapabilityFactory,
  type DirectoryControlCapabilityFactory as DirectoryControlCapabilityFactoryShape,
} from "../foundation/crypto";
import { ownerID, vaultID } from "../foundation/schemas";
import {
  DirectoryCredentialTransitionError,
  type DirectoryCredentialTransitionService,
  DirectoryTransitionAuthorizer,
  OwnerVaultCredentialFence,
  directoryTransitionFingerprint,
  makeDirectoryCredentialTransitionService,
} from "./credential-transition";
import { deriveDirectoryInitID, validDirectoryResolution } from "./invariants";
import { initializationDigest } from "./lifecycle";
import {
  DirectoryRepository,
  directoryTransactionError,
  makeDurableObjectDirectoryRepository,
  makeInMemoryDirectoryRepository,
} from "./repository";
import type {
  DirectoryOwnerFenceAck,
  DirectoryResolution,
  DirectoryState,
  DirectoryTransitionRequest,
} from "./types";

type Expect<T extends true> = T;
type ResumeCapabilityIsRequired = Expect<
  undefined extends Parameters<DirectoryCredentialTransitionService["resume"]>[1] ? false : true
>;
void (0 as unknown as ResumeCapabilityIsRequired);

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("invalid test setup");
  return value;
};
const now = 1_760_000_000;
const internalResume: DirectoryControlCapabilityFactoryShape = {
  signer: { sign: () => Effect.die("test does not sign") },
  verifier: {
    verify: () =>
      Effect.succeed({
        audience: DirectoryControlCapabilityAudience.DirectoryControl,
        authority: DirectoryControlCapabilityAuthority.DirectoryControl,
        resource: DirectoryControlResource.CredentialTransition,
        method: CapabilityMethod.POST,
        path: "/v2/internal/directory/credential-transition/resume",
        canonicalQuery: "",
        bodySHA256: "a".repeat(64),
        ownerID: "owner-transition-00000001",
        vaultID: "vault-transition-00000001",
        keyID: "test",
        jti: "credential-transition-0001",
        operationID: "credential-transition-0001",
        issuedAt: now,
        expiresAt: now + 60,
        credentialEpoch: 1,
        generationEpoch: 1,
        routingEpoch: 1,
      } satisfies DirectoryControlCapabilityClaims),
  },
};
const internalResumeToken = { value: "internal-resume-test-token" };
const realInternalResume: DirectoryControlCapabilityFactoryShape = {
  signer: makeDirectoryControlCapabilitySigner({
    purpose: "internal-capability",
    current: { keyID: "resume-current", secret: Redacted.make("resume-current-secret") },
    prior: [{ keyID: "resume-prior", secret: Redacted.make("resume-prior-secret") }],
  }),
  verifier: makeDirectoryControlCapabilityVerifier({
    purpose: "internal-capability",
    current: { keyID: "resume-current", secret: Redacted.make("resume-current-secret") },
    prior: [{ keyID: "resume-prior", secret: Redacted.make("resume-prior-secret") }],
  }),
};
const binding = `v2.a.${"A".repeat(43)}`;
const rebound = `v1.a.${"A".repeat(43)}`;
const otherBinding = `v2.b.${"A".repeat(43)}`;
const resolution = (): DirectoryResolution => ({
  ownerID: required(ownerID("owner-transition-00000001")),
  vaultID: required(vaultID("vault-transition-00000001")),
  initID: required(deriveDirectoryInitID(binding)),
  generationEpoch: 1,
  activeGeneration: 1,
  routingEpoch: 1,
  credentialEpoch: 1,
  controlEpoch: 1,
});
const initial = (): DirectoryState => ({
  aliases: { [binding]: binding },
  bindings: { [binding]: resolution() },
  replays: {},
  controlReplays: {},
  transitions: {},
  frozenBindings: {},
  retiredAliases: {},
  initializations: (() => {
    const resolved = resolution();
    const command = {
      ownerID: resolved.ownerID.value,
      vaultID: resolved.vaultID.value,
      generationEpoch: resolved.activeGeneration,
      operationID: "directory-initialization-0001",
      credentialEpoch: resolved.credentialEpoch,
      routingEpoch: resolved.routingEpoch,
      controlEpoch: 1,
    };
    const initialized = { ...command, initDigest: initializationDigest(command) };
    return {
      [binding]: {
        ...initialized,
        durableReceipt: "owner-vault-receipt-0001",
      },
    };
  })(),
  privateGenerations: {},
});
const otherResolution = (): DirectoryResolution => ({
  ownerID: required(ownerID("owner-transition-00000002")),
  vaultID: required(vaultID("vault-transition-00000002")),
  initID: required(deriveDirectoryInitID(otherBinding)),
  generationEpoch: 1,
  activeGeneration: 1,
  routingEpoch: 1,
  credentialEpoch: 1,
  controlEpoch: 1,
});
const request = (operationID = "credential-transition-0001"): DirectoryTransitionRequest => ({
  operationID,
  kind: "revoke",
  bindingID: binding,
  expected: resolution(),
  authority: {
    _tag: "registered_device",
    deviceID: "device-transition-00000001",
    proofID: "proof-transition-000000001",
  },
});
const mintResume = (
  transition: NonNullable<DirectoryState["transitions"][string]>,
  at: number,
  jti = transition.operationID,
) =>
  realInternalResume.signer.sign(
    {
      audience: DirectoryControlCapabilityAudience.DirectoryControl,
      authority: DirectoryControlCapabilityAuthority.DirectoryControl,
      resource: DirectoryControlResource.CredentialTransition,
      method: CapabilityMethod.POST,
      path: "/v2/internal/directory/credential-transition/resume",
      canonicalQuery: "",
      bodySHA256: sha256Hex(
        new TextEncoder().encode(JSON.stringify({ operationID: transition.operationID })),
      ),
      ownerID: transition.expected.ownerID.value,
      vaultID: transition.expected.vaultID.value,
      jti,
      operationID: transition.operationID,
      credentialEpoch: transition.expected.credentialEpoch,
      generationEpoch: transition.expected.activeGeneration,
      routingEpoch: transition.expected.routingEpoch,
      ttlSeconds: 60,
    },
    at,
  );

const mintResumeClaims = (
  transition: NonNullable<DirectoryState["transitions"][string]>,
  at: number,
  overrides: Partial<Omit<DirectoryControlCapabilityClaims, "keyID" | "issuedAt" | "expiresAt">> & {
    readonly ttlSeconds?: number;
  } = {},
  signer = realInternalResume.signer,
) =>
  signer.sign(
    {
      audience: DirectoryControlCapabilityAudience.DirectoryControl,
      authority: DirectoryControlCapabilityAuthority.DirectoryControl,
      resource: DirectoryControlResource.CredentialTransition,
      method: CapabilityMethod.POST,
      path: "/v2/internal/directory/credential-transition/resume",
      canonicalQuery: "",
      bodySHA256: sha256Hex(
        new TextEncoder().encode(JSON.stringify({ operationID: transition.operationID })),
      ),
      ownerID: transition.expected.ownerID.value,
      vaultID: transition.expected.vaultID.value,
      jti: "resume-control-token-000001",
      operationID: transition.operationID,
      credentialEpoch: transition.expected.credentialEpoch,
      generationEpoch: transition.expected.activeGeneration,
      routingEpoch: transition.expected.routingEpoch,
      ttlSeconds: 60,
      ...overrides,
    },
    at,
  );

const priorInternalResume: DirectoryControlCapabilityFactoryShape = {
  signer: makeDirectoryControlCapabilitySigner({
    purpose: "internal-capability",
    current: { keyID: "resume-prior", secret: Redacted.make("resume-prior-secret") },
    prior: [],
  }),
  verifier: realInternalResume.verifier,
};
const unknownInternalResume: DirectoryControlCapabilityFactoryShape = {
  signer: makeDirectoryControlCapabilitySigner({
    purpose: "internal-capability",
    current: { keyID: "resume-unknown", secret: Redacted.make("resume-unknown-secret") },
    prior: [],
  }),
  verifier: realInternalResume.verifier,
};
const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const rawSignedControlPayload = async (payload: string) => {
  const encoded = base64url(new TextEncoder().encode(payload));
  const signature = await Effect.runPromise(
    signCapabilityHmac(Redacted.make("resume-current-secret"), encoded),
  );
  return { value: `v1.${encoded}.${base64url(signature)}` };
};

const completedTransition = (
  operationID: string,
  retainUntil: number,
  bindingID = binding,
  expected = resolution(),
) => {
  const freeze = {
    operationID,
    credentialEpochFloor: expected.credentialEpoch + 1,
    routingEpochFloor: expected.routingEpoch + 1,
  };
  const ownerAck: DirectoryOwnerFenceAck = {
    ownerID: expected.ownerID.value,
    vaultID: expected.vaultID.value,
    generation: expected.activeGeneration,
    operationID,
    expectedCredentialEpoch: expected.credentialEpoch,
    expectedRoutingEpoch: expected.routingEpoch,
    credentialEpoch: freeze.credentialEpochFloor,
    routingEpoch: freeze.routingEpochFloor,
    admissionsStopped: true,
    socketsFenced: true,
  };
  return {
    operationID,
    fingerprint: "a".repeat(64),
    kind: "revoke" as const,
    bindingID,
    expected,
    sourceAliases: [bindingID],
    replacementAliases: [],
    phase: "COMPLETED" as const,
    freeze,
    ownerAck,
    result: {
      operationID,
      kind: "revoke" as const,
      bindingID,
      credentialEpoch: ownerAck.credentialEpoch,
      routingEpoch: ownerAck.routingEpoch,
    },
    createdAt: retainUntil - 360,
    expiresAt: retainUntil - 300,
    retainUntil,
  };
};
const retiredFor = (transition: ReturnType<typeof completedTransition>) => ({
  bindingID: transition.bindingID,
  operationID: transition.operationID,
  ownerID: transition.expected.ownerID.value,
  vaultID: transition.expected.vaultID.value,
  reason: transition.kind,
  retiredAt: transition.createdAt,
  activeGeneration: transition.expected.activeGeneration,
  credentialEpoch: transition.freeze.credentialEpochFloor,
  routingEpoch: transition.freeze.routingEpochFloor,
});

/**
 * This deliberately uses the production durable codec and transaction boundary. A new service
 * gets a new repository wrapper, just as a recreated DO would, while `entries` remains the
 * durable bytes from the preceding incarnation.
 */
const durableState = (): {
  readonly entries: Map<string, unknown>;
  readonly state: DurableObjectStateNative;
} => {
  const entries = new Map<string, unknown>();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
    transaction: (work) => {
      const before = new Map(entries);
      return work(transaction).catch((failure: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        return Promise.reject(failure);
      });
    },
  };
  return { entries, state: { storage, blockConcurrencyWhile: (work) => work() } };
};

const durableTransitionSetup = (
  durable: ReturnType<typeof durableState>,
  owner: OwnerVaultCredentialFence,
  failAfterCommit?: number,
  capabilities: DirectoryControlCapabilityFactoryShape = internalResume,
) =>
  Effect.gen(function* () {
    const commits = yield* Ref.make(0);
    const base = makeDurableObjectDirectoryRepository(
      makeDurableObjectBoundary(durable.state).storage,
    );
    const repository: DirectoryRepository = {
      transact: (operation) =>
        base
          .transact(operation)
          .pipe(
            Effect.flatMap((value) =>
              Ref.updateAndGet(commits, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === failAfterCommit
                    ? Effect.fail(directoryTransactionError("repository_unavailable"))
                    : Effect.succeed(value),
                ),
              ),
            ),
          ),
    };
    const service = yield* makeDirectoryCredentialTransitionService.pipe(
      Effect.provideService(DirectoryRepository, repository),
      Effect.provideService(DirectoryTransitionAuthorizer, { authorize: () => Effect.void }),
      Effect.provideService(DirectoryControlCapabilityFactory, capabilities),
      Effect.provideService(OwnerVaultCredentialFence, owner),
    );
    return { commits, service };
  });

const initializeDurableDirectory = (durable: ReturnType<typeof durableState>) =>
  makeDurableObjectDirectoryRepository(makeDurableObjectBoundary(durable.state).storage).transact(
    () => Effect.succeed([undefined, initial()] as const),
  );

const durableOwner = (throwAfterApply = false) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const applied = yield* Ref.make(new Map<string, DirectoryOwnerFenceAck>());
    const shouldThrow = yield* Ref.make(throwAfterApply);
    const owner: OwnerVaultCredentialFence = {
      fenceCredentialEpoch: (input) =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.flatMap(() =>
            Ref.get(applied).pipe(
              Effect.flatMap((known) => {
                const ack =
                  known.get(input.operationID) ??
                  ({
                    ...input,
                    credentialEpoch: input.expectedCredentialEpoch + 1,
                    routingEpoch: input.expectedRoutingEpoch + 1,
                    admissionsStopped: true,
                    socketsFenced: true,
                  } satisfies DirectoryOwnerFenceAck);
                return Ref.set(applied, new Map(known).set(input.operationID, ack)).pipe(
                  Effect.flatMap(() =>
                    Ref.getAndSet(shouldThrow, false).pipe(
                      Effect.flatMap((lost) =>
                        lost
                          ? Effect.fail(
                              new DirectoryCredentialTransitionError({ reason: "owner_rejected" }),
                            )
                          : Effect.succeed(ack),
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
    };
    return { applied, calls, owner };
  });

const setup = (ackMode: "valid" | "stale" | "overshoot" | "fail" | "yield" = "valid") =>
  Effect.gen(function* () {
    const memory = yield* makeInMemoryDirectoryRepository;
    yield* Ref.set(memory.state, initial());
    const calls = yield* Ref.make(0);
    const owner = {
      fenceCredentialEpoch: (input: {
        readonly ownerID: string;
        readonly vaultID: string;
        readonly generation: number;
        readonly operationID: string;
        readonly expectedCredentialEpoch: number;
        readonly expectedRoutingEpoch: number;
      }) =>
        Ref.updateAndGet(calls, (value) => value + 1).pipe(
          Effect.flatMap(() =>
            ackMode === "fail"
              ? Effect.fail(new DirectoryCredentialTransitionError({ reason: "owner_rejected" }))
              : (ackMode === "yield" ? Effect.yieldNow() : Effect.void).pipe(
                  Effect.as({
                    ...input,
                    credentialEpoch:
                      ackMode === "stale"
                        ? input.expectedCredentialEpoch
                        : ackMode === "overshoot"
                          ? input.expectedCredentialEpoch + 2
                          : input.expectedCredentialEpoch + 1,
                    routingEpoch: input.expectedRoutingEpoch + 1,
                    admissionsStopped: true as const,
                    socketsFenced: true as const,
                  }),
                ),
          ),
        ),
    };
    const service = yield* makeDirectoryCredentialTransitionService.pipe(
      Effect.provide(memory.layer),
      Effect.provideService(DirectoryTransitionAuthorizer, { authorize: () => Effect.void }),
      Effect.provideService(DirectoryControlCapabilityFactory, internalResume),
      Effect.provideService(OwnerVaultCredentialFence, owner),
    );
    return { calls, memory, service };
  });

/** A real capability verifier with a frozen journal and no prior OwnerVault callback. */
const realFrozenResumeSetup = Effect.gen(function* () {
  const memory = yield* makeInMemoryDirectoryRepository;
  yield* Ref.set(memory.state, initial());
  const calls = yield* Ref.make(0);
  const owner: OwnerVaultCredentialFence = {
    fenceCredentialEpoch: () =>
      Ref.update(calls, (count) => count + 1).pipe(
        Effect.flatMap(() =>
          Effect.fail(new DirectoryCredentialTransitionError({ reason: "owner_rejected" })),
        ),
      ),
  };
  const service = yield* makeDirectoryCredentialTransitionService.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(DirectoryTransitionAuthorizer, { authorize: () => Effect.void }),
    Effect.provideService(DirectoryControlCapabilityFactory, realInternalResume),
    Effect.provideService(OwnerVaultCredentialFence, owner),
  );
  expect(Exit.isFailure(yield* Effect.exit(service.execute(request(), now)))).toBe(true);
  yield* Ref.set(calls, 0);
  const transition = required((yield* Ref.get(memory.state)).transitions[request().operationID]);
  return { calls, memory, service, transition };
});

describe("v2 CredentialDirectory revoke/rebind journal", () => {
  test("revokes exactly once, retains only request evidence, and replays the terminal result", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup());
    const first = await Effect.runPromise(service.execute(request(), now));
    const replay = await Effect.runPromise(service.execute(request(), now));
    expect(replay).toEqual(first);
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.bindings[binding]).toBeUndefined();
    expect(state.frozenBindings[binding]).toBeUndefined();
    expect(state.transitions[request().operationID]?.phase).toBe("COMPLETED");
    expect(JSON.stringify(state)).not.toContain("device-transition-00000001");
    expect(JSON.stringify(state)).not.toContain("proof-transition-000000001");
  });

  test("keeps admission frozen after an ambiguous OwnerVault failure and resumes forward-only", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup("fail"));
    const first = await Effect.runPromiseExit(service.execute(request(), now));
    expect(Exit.isFailure(first)).toBe(true);
    expect((await Effect.runPromise(Ref.get(memory.state))).frozenBindings[binding]).toBeDefined();
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
    const resumed = await Effect.runPromiseExit(
      service.resume(request().operationID, internalResumeToken, now + 1),
    );
    expect(Exit.isFailure(resumed)).toBe(true);
    expect((await Effect.runPromise(Ref.get(memory.state))).frozenBindings[binding]).toBeDefined();
  });

  test("rejects stale owner acknowledgement before Directory CAS", async () => {
    const { memory, service } = await Effect.runPromise(setup("stale"));
    const exit = await Effect.runPromiseExit(service.execute(request(), now));
    expect(Exit.isFailure(exit)).toBe(true);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.bindings[binding]).toBeDefined();
    expect(state.frozenBindings[binding]).toBeDefined();
    expect(state.transitions[request().operationID]?.phase).toBe("FROZEN");
  });

  test("rejects an OwnerVault epoch overshoot before Directory CAS", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup("overshoot"));
    const exit = await Effect.runPromiseExit(service.execute(request(), now));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("owner_ack_mismatch");
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.transitions[request().operationID]?.phase).toBe("FROZEN");
    expect(state.bindings[binding]).toEqual(resolution());
    expect(state.frozenBindings[binding]).toBeDefined();
  });

  test("rejects overflow before freezing or invoking OwnerVault", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup());
    const maximum = {
      ...resolution(),
      credentialEpoch: Number.MAX_SAFE_INTEGER,
      routingEpoch: Number.MAX_SAFE_INTEGER,
    };
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...initial(),
        bindings: { [binding]: maximum },
      }),
    );
    const exit = await Effect.runPromiseExit(
      service.execute({ ...request(), expected: maximum }, now),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("invalid_request");
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0);
    expect(await Effect.runPromise(Ref.get(memory.state))).toEqual({
      ...initial(),
      bindings: { [binding]: maximum },
    });
  });

  test("rejects forged OwnerVault scope evidence without advancing Directory", async () => {
    const memory = await Effect.runPromise(makeInMemoryDirectoryRepository);
    await Effect.runPromise(Ref.set(memory.state, initial()));
    const owner: OwnerVaultCredentialFence = {
      fenceCredentialEpoch: (input) =>
        Effect.succeed({
          ...input,
          ownerID: "owner-transition-00000002", // valid-looking, but not the frozen owner
          credentialEpoch: input.expectedCredentialEpoch + 1,
          routingEpoch: input.expectedRoutingEpoch + 1,
          admissionsStopped: true,
          socketsFenced: true,
        }),
    };
    const service = await Effect.runPromise(
      makeDirectoryCredentialTransitionService.pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryTransitionAuthorizer, { authorize: () => Effect.void }),
        Effect.provideService(DirectoryControlCapabilityFactory, realInternalResume),
        Effect.provideService(OwnerVaultCredentialFence, owner),
      ),
    );
    const exit = await Effect.runPromiseExit(service.execute(request(), now));
    expect(Exit.isFailure(exit)).toBe(true);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.transitions[request().operationID]?.phase).toBe("FROZEN");
    expect(state.bindings[binding]).toEqual(resolution());
  });

  test("rejects alias collision before OwnerVault fencing", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup());
    const collisionState = initial();
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...collisionState,
        aliases: { ...collisionState.aliases, [rebound]: otherBinding },
        bindings: { ...collisionState.bindings, [otherBinding]: otherResolution() },
      }),
    );
    const rebind: DirectoryTransitionRequest = {
      ...request("credential-rebind-00000001"),
      kind: "rebind",
      replacementAliases: [rebound],
    };
    const exit = await Effect.runPromiseExit(service.execute(rebind, now));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0);
  });

  test("rebind atomically removes old aliases and preserves the Owner/Vault behind the new binding", async () => {
    const { memory, service } = await Effect.runPromise(setup());
    const rebind: DirectoryTransitionRequest = {
      ...request("credential-rebind-00000002"),
      kind: "rebind",
      replacementAliases: [rebound],
    };
    const transitioned = await Effect.runPromise(service.execute(rebind, now));
    expect(transitioned.replacementBindingID).toBe(rebound);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.bindings[binding]).toBeUndefined();
    expect(state.aliases[binding]).toBeUndefined();
    expect(state.aliases[rebound]).toBe(rebound);
    expect(state.bindings[rebound]?.ownerID.value).toBe(resolution().ownerID.value);
    expect(state.bindings[rebound]?.vaultID.value).toBe(resolution().vaultID.value);
    expect(state.bindings[rebound]?.credentialEpoch).toBe(2);
  });

  test("never rebinds an active replacement back to a permanently retired source alias", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup());
    await Effect.runPromise(
      service.execute(
        {
          ...request("credential-rebind-forward-01"),
          kind: "rebind",
          replacementAliases: [rebound],
        },
        now,
      ),
    );
    const active = required((await Effect.runPromise(Ref.get(memory.state))).bindings[rebound]);
    expect(validDirectoryResolution(rebound, active)).toBe(true);
    const reverse: DirectoryTransitionRequest = {
      ...request("credential-transition-0002"),
      kind: "rebind",
      bindingID: rebound,
      expected: active,
      replacementAliases: [binding],
    };
    expect(directoryTransitionFingerprint(reverse)).toBeDefined();
    const denied = await Effect.runPromiseExit(service.execute(reverse, now + 1));
    expect(Exit.isFailure(denied)).toBe(true);
    expect(JSON.stringify(denied)).toContain("alias_conflict");
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.bindings[rebound]).toEqual(active);
    expect(state.frozenBindings[rebound]).toBeUndefined();
    expect(state.transitions[reverse.operationID]).toBeUndefined();
    expect(state.retiredAliases[binding]?.reason).toBe("rebind");
  });

  test("rebinds a source alias into the replacement without treating it as a collision", async () => {
    const { memory, service } = await Effect.runPromise(setup());
    await Effect.runPromise(
      Ref.update(memory.state, (state) => ({
        ...state,
        aliases: { ...state.aliases, [rebound]: binding },
      })),
    );
    const transitioned = await Effect.runPromise(
      service.execute(
        {
          ...request("credential-rebind-00000007"),
          kind: "rebind",
          replacementAliases: [rebound],
        },
        now,
      ),
    );
    expect(transitioned.replacementBindingID).toBe(rebound);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.aliases[rebound]).toBe(rebound);
    expect(state.bindings[rebound]?.credentialEpoch).toBe(2);
  });

  test("rejects corrupt pre-CAS replacement alias reuse before a callback", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup("fail"));
    await Effect.runPromise(
      Ref.update(memory.state, (state) => ({
        ...state,
        aliases: { ...state.aliases, [rebound]: binding },
      })),
    );
    const transitionRequest: DirectoryTransitionRequest = {
      ...request("credential-rebind-00000008"),
      kind: "rebind",
      replacementAliases: [rebound],
    };
    expect(
      Exit.isFailure(await Effect.runPromiseExit(service.execute(transitionRequest, now))),
    ).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
    const frozen = required(
      (await Effect.runPromise(Ref.get(memory.state))).transitions[transitionRequest.operationID],
    );
    const aliasResolution: DirectoryResolution = {
      ...otherResolution(),
      initID: required(deriveDirectoryInitID(rebound)),
    };
    const corruptions: readonly DirectoryState[] = [
      {
        ...(await Effect.runPromise(Ref.get(memory.state))),
        aliases: { [binding]: binding, [rebound]: otherBinding },
        bindings: { [binding]: resolution(), [otherBinding]: otherResolution() },
      },
      {
        ...(await Effect.runPromise(Ref.get(memory.state))),
        transitions: {
          [frozen.operationID]: { ...frozen, sourceAliases: [binding] },
        },
      },
      {
        ...(await Effect.runPromise(Ref.get(memory.state))),
        bindings: { [binding]: resolution(), [rebound]: aliasResolution },
      },
    ];
    for (const corrupt of corruptions) {
      await Effect.runPromise(Ref.set(memory.state, corrupt));
      let callbacks = 0;
      const exit = await Effect.runPromiseExit(
        memory.repository.transact((state) =>
          Effect.sync(() => {
            callbacks += 1;
            return [undefined, state] as const;
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(callbacks).toBe(0);
    }
  });

  test("retains completed evidence while a later rebind supersedes its live map", async () => {
    const { memory, service } = await Effect.runPromise(setup());
    const firstRequest: DirectoryTransitionRequest = {
      ...request("credential-rebind-00000005"),
      kind: "rebind",
      replacementAliases: [rebound],
    };
    const first = await Effect.runPromise(service.execute(firstRequest, now));
    const firstExpected: DirectoryResolution = {
      ...resolution(),
      initID: required(deriveDirectoryInitID(rebound)),
      credentialEpoch: first.credentialEpoch,
      routingEpoch: first.routingEpoch,
    };
    const second = await Effect.runPromise(
      service.execute(
        {
          ...request("credential-rebind-00000006"),
          kind: "rebind",
          bindingID: rebound,
          expected: firstExpected,
          replacementAliases: [otherBinding],
        },
        now + 1,
      ),
    );
    expect(second.replacementBindingID).toBe(otherBinding);
    const state = await Effect.runPromise(Ref.get(memory.state));
    expect(state.bindings[otherBinding]?.credentialEpoch).toBe(3);
    expect(state.transitions[first.operationID]?.phase).toBe("COMPLETED");
    expect(state.transitions[second.operationID]?.phase).toBe("COMPLETED");
  });

  test("treats a changed duplicate request as an operation conflict", async () => {
    const { service } = await Effect.runPromise(setup());
    await Effect.runPromise(service.execute(request(), now));
    const changed: DirectoryTransitionRequest = {
      ...request(),
      authority: { _tag: "offline_recovery", recoveryID: "recovery-transition-00001" },
    };
    const exit = await Effect.runPromiseExit(service.execute(changed, now));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("operation_conflict");
  });

  test("replays a live completed receipt without reauthorizing, but expires it before resume", async () => {
    const memory = await Effect.runPromise(makeInMemoryDirectoryRepository);
    await Effect.runPromise(Ref.set(memory.state, initial()));
    const authorizations = await Effect.runPromise(Ref.make(0));
    const owner = await Effect.runPromise(durableOwner());
    const service = await Effect.runPromise(
      makeDirectoryCredentialTransitionService.pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryTransitionAuthorizer, {
          authorize: () => Ref.update(authorizations, (count) => count + 1),
        }),
        Effect.provideService(DirectoryControlCapabilityFactory, internalResume),
        Effect.provideService(OwnerVaultCredentialFence, owner.owner),
      ),
    );
    const terminal = await Effect.runPromise(service.execute(request(), now));
    const replay = await Effect.runPromise(service.execute(request(), now + 1));
    expect(replay).toEqual(terminal);
    expect(await Effect.runPromise(Ref.get(authorizations))).toBe(1);
    const expired = await Effect.runPromiseExit(
      service.resume(request().operationID, internalResumeToken, now + 360),
    );
    expect(Exit.isFailure(expired)).toBe(true);
    expect(
      (await Effect.runPromise(Ref.get(memory.state))).transitions[request().operationID],
    ).toBeUndefined();
  });

  test("continues an already-prepared operation without consulting a newly-revoked authorizer", async () => {
    const memory = await Effect.runPromise(makeInMemoryDirectoryRepository);
    await Effect.runPromise(Ref.set(memory.state, initial()));
    const firstOwner = await Effect.runPromise(durableOwner(true));
    const first = await Effect.runPromise(
      makeDirectoryCredentialTransitionService.pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryTransitionAuthorizer, { authorize: () => Effect.void }),
        Effect.provideService(DirectoryControlCapabilityFactory, internalResume),
        Effect.provideService(OwnerVaultCredentialFence, firstOwner.owner),
      ),
    );
    expect(Exit.isFailure(await Effect.runPromiseExit(first.execute(request(), now)))).toBe(true);

    const authorizerCalls = await Effect.runPromise(Ref.make(0));
    const resumedOwner = await Effect.runPromise(durableOwner());
    const resumed = await Effect.runPromise(
      makeDirectoryCredentialTransitionService.pipe(
        Effect.provide(memory.layer),
        Effect.provideService(DirectoryTransitionAuthorizer, {
          authorize: () =>
            Ref.update(authorizerCalls, (count) => count + 1).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new DirectoryCredentialTransitionError({ reason: "authority_rejected" }),
                ),
              ),
            ),
        }),
        Effect.provideService(DirectoryControlCapabilityFactory, realInternalResume),
        Effect.provideService(OwnerVaultCredentialFence, resumedOwner.owner),
      ),
    );
    expect(
      Exit.isFailure(await Effect.runPromiseExit(resumed.execute(request(), now + 1_000))),
    ).toBe(true);
    expect(await Effect.runPromise(Ref.get(authorizerCalls))).toBe(1);
    const transition = (await Effect.runPromise(Ref.get(memory.state))).transitions[
      request().operationID
    ];
    const token = await Effect.runPromise(
      mintResume(required(transition), now + 1_000, "resume-token-00000001"),
    );
    await Effect.runPromise(resumed.resume(request().operationID, token, now + 1_000));
    expect(
      (await Effect.runPromise(Ref.get(memory.state))).controlReplays["resume-token-00000001"]
        ?.operationID,
    ).toBe(request().operationID);
  });

  test("rejects an unaliased replacement binding and forged retention before callbacks", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup());
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...initial(),
        bindings: {
          ...initial().bindings,
          [rebound]: { ...otherResolution(), initID: required(deriveDirectoryInitID(rebound)) },
        },
      }),
    );
    const collide = await Effect.runPromiseExit(
      service.execute(
        { ...request("credential-rebind-00000003"), kind: "rebind", replacementAliases: [rebound] },
        now,
      ),
    );
    expect(Exit.isFailure(collide)).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0);

    const forged = completedTransition("credential-transition-0009", now + 301);
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...initial(),
        transitions: { [forged.operationID]: { ...forged, retainUntil: forged.expiresAt + 301 } },
      }),
    );
    const invalid = await Effect.runPromiseExit(
      service.resume(forged.operationID, internalResumeToken, now),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0);

    const overflowing = {
      ...completedTransition("credential-transition-0010", now + 360),
      createdAt: Number.MAX_SAFE_INTEGER - 60,
      expiresAt: Number.MAX_SAFE_INTEGER - 1,
      retainUntil: Number.MAX_SAFE_INTEGER,
    };
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...initial(),
        transitions: { [overflowing.operationID]: overflowing },
      }),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          service.resume(overflowing.operationID, internalResumeToken, now),
        ),
      ),
    ).toBe(true);
  });

  test("bounds transition receipt retention independently of bootstrap replay receipts", async () => {
    const { calls, memory, service } = await Effect.runPromise(setup());
    const complete = Array.from({ length: 1_024 }, (_, index) => {
      const operationID = `receipt${index.toString(16).padStart(9, "0")}`;
      const bindingID = `v2.${index}.${"A".repeat(43)}`;
      const expected: DirectoryResolution = {
        ownerID: required(ownerID(`owner-receipt-${String(index).padStart(16, "0")}`)),
        vaultID: required(vaultID(`vault-receipt-${String(index).padStart(16, "0")}`)),
        initID: required(deriveDirectoryInitID(bindingID)),
        generationEpoch: 1,
        activeGeneration: 1,
        routingEpoch: 1,
        credentialEpoch: 1,
        controlEpoch: 1,
      };
      return completedTransition(operationID, now + 300, bindingID, expected);
    });
    const saturated = Object.fromEntries(
      complete.map((transition) => [transition.operationID, transition]),
    );
    const retiredAliases = Object.fromEntries(
      complete.map((transition) => [transition.bindingID, retiredFor(transition)]),
    );
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...initial(),
        aliases: {},
        bindings: {},
        initializations: {},
        privateGenerations: {},
        transitions: saturated,
        retiredAliases,
      }),
    );
    const full = await Effect.runPromiseExit(service.execute(request(), now));
    expect(Exit.isFailure(full)).toBe(true);
    expect(JSON.stringify(full)).toContain("operation_capacity");
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0);

    // A fresh DO incarnation prunes expiry before admitting the new operation; no bootstrap
    // replay evidence is involved in this lifecycle receipt bound.
    const expired = Object.fromEntries(
      Object.entries(saturated).map(([id, transition]) => [
        id,
        { ...transition, createdAt: now - 360, expiresAt: now - 300, retainUntil: now },
      ]),
    );
    const expiredRetiredAliases = Object.fromEntries(
      Object.entries(retiredAliases).map(([alias, retired]) => [
        alias,
        {
          ...retired,
          retiredAt: now - 360,
        },
      ]),
    );
    await Effect.runPromise(
      Ref.set(memory.state, {
        ...initial(),
        transitions: expired,
        retiredAliases: expiredRetiredAliases,
      }),
    );
    await Effect.runPromise(service.execute(request(), now));
    const after = await Effect.runPromise(Ref.get(memory.state));
    expect(Object.keys(after.transitions)).toEqual([request().operationID]);
  });

  test("serializes concurrent same and different operations without a second OwnerVault fence", async () => {
    const { calls, service } = await Effect.runPromise(setup());
    const same = request();
    const different = request("credential-transition-0002");
    const [first, replay, second] = await Effect.runPromise(
      Effect.all(
        [
          service.execute(same, now),
          service.execute(same, now),
          service.execute(different, now).pipe(Effect.either),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect(replay).toEqual(first);
    expect(second._tag).toBe("Left");
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
  });

  test("returns one exact terminal receipt when duplicate OwnerVault acknowledgements race", async () => {
    const { calls, service } = await Effect.runPromise(setup("yield"));
    const [first, second] = await Effect.runPromise(
      Effect.all([service.execute(request(), now), service.execute(request(), now)], {
        concurrency: "unbounded",
      }),
    );
    expect(first).toEqual(second);
    // Directory cannot hold its DO transaction across the OwnerVault call. OwnerVault's
    // operation ID is therefore idempotent, and Directory accepts only the exact same ack.
    expect(await Effect.runPromise(Ref.get(calls))).toBe(2);
  });

  test("recovers the exact terminal result after a crash following every durable transition", async () => {
    // The five commits are PREPARED, FROZEN, OWNER_ACKED, DIRECTORY_CAS, COMPLETED. Failure is
    // injected *after* the durable transaction returns, modelling an isolate dying before it can
    // reply. The next incarnation must only drive the journal forward.
    for (const crashAfterCommit of [2, 3, 4, 5, 6]) {
      const durable = durableState();
      await Effect.runPromise(initializeDurableDirectory(durable));
      const owner = await Effect.runPromise(durableOwner());
      const first = await Effect.runPromise(
        durableTransitionSetup(durable, owner.owner, crashAfterCommit),
      );
      const crashed = await Effect.runPromiseExit(first.service.execute(request(), now));
      expect(Exit.isFailure(crashed)).toBe(true);

      const restarted = await Effect.runPromise(durableTransitionSetup(durable, owner.owner));
      const terminal = await Effect.runPromise(
        restarted.service.resume(request().operationID, internalResumeToken, now),
      );
      expect(terminal).toEqual({
        operationID: request().operationID,
        kind: "revoke",
        bindingID: binding,
        credentialEpoch: 2,
        routingEpoch: 2,
      });
      const replay = await Effect.runPromise(restarted.service.execute(request(), now));
      expect(replay).toEqual(terminal);
      // The owner has an idempotent operation record. A restart never applies the fence twice.
      expect((await Effect.runPromise(Ref.get(owner.applied))).size).toBe(1);
      expect(await Effect.runPromise(Ref.get(owner.calls))).toBe(1);
    }
  });

  test("round-trips persisted OwnerVault acknowledgements at every later phase and rejects malformed acknowledgement shapes", async () => {
    // Commits three through five are OWNER_ACKED, DIRECTORY_CAS, and COMPLETED. A fresh
    // repository wrapper must be able to decode and re-encode each durable representation
    // before the transition service resumes it.
    for (const crashAfterCommit of [4, 5, 6]) {
      const durable = durableState();
      await Effect.runPromise(initializeDurableDirectory(durable));
      const owner = await Effect.runPromise(durableOwner());
      const first = await Effect.runPromise(
        durableTransitionSetup(durable, owner.owner, crashAfterCommit),
      );
      expect(
        Exit.isFailure(await Effect.runPromiseExit(first.service.execute(request(), now))),
      ).toBe(true);

      const repository = makeDurableObjectDirectoryRepository(
        makeDurableObjectBoundary(durable.state).storage,
      );
      const decoded = await Effect.runPromise(
        repository.transact((state) =>
          Effect.succeed([state.transitions[request().operationID], state]),
        ),
      );
      expect(decoded?.ownerAck).toEqual({
        ownerID: resolution().ownerID.value,
        vaultID: resolution().vaultID.value,
        generation: 1,
        operationID: request().operationID,
        expectedCredentialEpoch: 1,
        expectedRoutingEpoch: 1,
        credentialEpoch: 2,
        routingEpoch: 2,
        admissionsStopped: true,
        socketsFenced: true,
      });
    }

    const durable = durableState();
    await Effect.runPromise(initializeDurableDirectory(durable));
    const owner = await Effect.runPromise(durableOwner());
    const first = await Effect.runPromise(durableTransitionSetup(durable, owner.owner, 4));
    expect(Exit.isFailure(await Effect.runPromiseExit(first.service.execute(request(), now)))).toBe(
      true,
    );
    const persisted = required(durable.entries.get("v2.directory.state")) as {
      readonly transitions: Readonly<Record<string, Record<string, unknown>>>;
    };
    const transition = required(persisted.transitions[request().operationID]);
    const ownerAck = required(transition.ownerAck as Record<string, unknown>);

    for (const malformedAck of [
      Object.fromEntries(Object.entries(ownerAck).filter(([key]) => key !== "generation")),
      { ...ownerAck, unexpectedGeneration: ownerAck.generation },
    ]) {
      durable.entries.set("v2.directory.state", {
        ...persisted,
        transitions: {
          ...persisted.transitions,
          [request().operationID]: { ...transition, ownerAck: malformedAck },
        },
      });
      const before = JSON.stringify([...durable.entries.entries()]);
      const exit = await Effect.runPromiseExit(
        makeDurableObjectDirectoryRepository(
          makeDurableObjectBoundary(durable.state).storage,
        ).transact((state) => Effect.succeed([undefined, state] as const)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify([...durable.entries.entries()])).toBe(before);
    }
  });

  test("rejects a corrupt live map for every durable nonterminal/CAS phase before callbacks", async () => {
    const requests: readonly DirectoryTransitionRequest[] = [
      request(),
      {
        ...request("credential-rebind-00000004"),
        kind: "rebind",
        replacementAliases: [rebound],
      },
    ];
    // Commit 2..5 persist PREPARED through DIRECTORY_CAS after the initial load transaction.
    for (const transitionRequest of requests) {
      for (const crashAfterCommit of [2, 3, 4, 5]) {
        const durable = durableState();
        await Effect.runPromise(initializeDurableDirectory(durable));
        const owner = await Effect.runPromise(durableOwner());
        const first = await Effect.runPromise(
          durableTransitionSetup(durable, owner.owner, crashAfterCommit),
        );
        expect(
          Exit.isFailure(
            await Effect.runPromiseExit(first.service.execute(transitionRequest, now)),
          ),
        ).toBe(true);

        const persisted = required(durable.entries.get("v2.directory.state")) as {
          readonly aliases: Readonly<Record<string, string>>;
          readonly bindings: Readonly<Record<string, unknown>>;
          readonly replays: unknown;
          readonly controlReplays: unknown;
          readonly transitions: Readonly<Record<string, { readonly phase: string }>>;
          readonly frozenBindings: unknown;
        };
        const persistedPhase = required(Object.values(persisted.transitions)[0]).phase;
        // PREPARED/FROZEN/OWNER_ACKED require the source map; DIRECTORY_CAS requires the final
        // map. Give each phase the other representation.
        durable.entries.set("v2.directory.state", {
          ...persisted,
          aliases: persistedPhase === "DIRECTORY_CAS" ? { [binding]: binding } : {},
          bindings: persistedPhase === "DIRECTORY_CAS" ? { [binding]: resolution() } : {},
        });
        const before = JSON.stringify([...durable.entries.entries()]);
        let callbacks = 0;
        const repository = makeDurableObjectDirectoryRepository(
          makeDurableObjectBoundary(durable.state).storage,
        );
        const exit = await Effect.runPromiseExit(
          repository.transact((state) =>
            Effect.sync(() => {
              callbacks += 1;
              return [undefined, state] as const;
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(callbacks).toBe(0);
        expect(JSON.stringify([...durable.entries.entries()])).toBe(before);
      }
    }
  });

  test("rejects persisted lowered or skipped epoch floors before callbacks", async () => {
    for (const forgedFloor of [1, 3]) {
      const durable = durableState();
      await Effect.runPromise(initializeDurableDirectory(durable));
      const owner = await Effect.runPromise(durableOwner());
      const first = await Effect.runPromise(durableTransitionSetup(durable, owner.owner, 2));
      expect(
        Exit.isFailure(await Effect.runPromiseExit(first.service.execute(request(), now))),
      ).toBe(true);
      const persisted = required(durable.entries.get("v2.directory.state")) as {
        readonly frozenBindings: Readonly<Record<string, Record<string, unknown>>>;
        readonly transitions: Readonly<Record<string, Record<string, unknown>>>;
      };
      const transition = required(persisted.transitions[request().operationID]);
      const freeze = {
        ...required(transition.freeze as Record<string, unknown>),
        credentialEpochFloor: forgedFloor,
        routingEpochFloor: forgedFloor,
      };
      durable.entries.set("v2.directory.state", {
        ...persisted,
        transitions: {
          ...persisted.transitions,
          [request().operationID]: { ...transition, freeze },
        },
        frozenBindings: { ...persisted.frozenBindings, [binding]: freeze },
      });
      let callbacks = 0;
      const exit = await Effect.runPromiseExit(
        makeDurableObjectDirectoryRepository(
          makeDurableObjectBoundary(durable.state).storage,
        ).transact((state) =>
          Effect.sync(() => {
            callbacks += 1;
            return [undefined, state] as const;
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(callbacks).toBe(0);
    }
  });

  test("holds the binding frozen when OwnerVault applied the fence but its response was lost", async () => {
    const durable = durableState();
    await Effect.runPromise(initializeDurableDirectory(durable));
    const owner = await Effect.runPromise(durableOwner(true));
    const first = await Effect.runPromise(durableTransitionSetup(durable, owner.owner));
    const ambiguous = await Effect.runPromiseExit(first.service.execute(request(), now));
    expect(Exit.isFailure(ambiguous)).toBe(true);

    const beforeRetry = makeDurableObjectDirectoryRepository(
      makeDurableObjectBoundary(durable.state).storage,
    );
    const frozen = await Effect.runPromise(
      beforeRetry.transact((state) => Effect.succeed([state, state] as const)),
    );
    expect(frozen.transitions[request().operationID]?.phase).toBe("FROZEN");
    expect(frozen.frozenBindings[binding]).toBeDefined();
    expect(frozen.bindings[binding]).toEqual(resolution()); // Directory never commits before ack.

    const restarted = await Effect.runPromise(durableTransitionSetup(durable, owner.owner));
    await Effect.runPromise(
      restarted.service.resume(request().operationID, internalResumeToken, now + 1),
    );
    expect((await Effect.runPromise(Ref.get(owner.applied))).size).toBe(1);
    expect(await Effect.runPromise(Ref.get(owner.calls))).toBe(2);
  });

  test("recovers a real control token claimed before a crash and fences the OwnerVault operation once", async () => {
    const durable = durableState();
    await Effect.runPromise(initializeDurableDirectory(durable));
    const owner = await Effect.runPromise(durableOwner(true));
    const first = await Effect.runPromise(
      durableTransitionSetup(durable, owner.owner, undefined, realInternalResume),
    );
    expect(Exit.isFailure(await Effect.runPromiseExit(first.service.execute(request(), now)))).toBe(
      true,
    );

    const repository = makeDurableObjectDirectoryRepository(
      makeDurableObjectBoundary(durable.state).storage,
    );
    const frozen = await Effect.runPromise(
      repository.transact((state) =>
        Effect.succeed([required(state.transitions[request().operationID]), state] as const),
      ),
    );
    const exact = await Effect.runPromise(
      mintResumeClaims(frozen, now + 1, { jti: "resume-crash-exact-000001" }),
    );

    // `load` is the first transaction and the JTI claim is the second. The wrapped repository
    // fails after the latter persisted, exactly where an isolate can die before its Owner RPC.
    const crashAfterClaim = await Effect.runPromise(
      durableTransitionSetup(durable, owner.owner, 2, realInternalResume),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          crashAfterClaim.service.resume(request().operationID, exact, now + 1),
        ),
      ),
    ).toBe(true);
    expect(await Effect.runPromise(Ref.get(owner.calls))).toBe(1);

    const restarted = await Effect.runPromise(
      durableTransitionSetup(durable, owner.owner, undefined, realInternalResume),
    );
    const terminal = await Effect.runPromise(
      restarted.service.resume(request().operationID, exact, now + 1),
    );
    expect(terminal.credentialEpoch).toBe(2);
    expect((await Effect.runPromise(Ref.get(owner.applied))).size).toBe(1);
    expect(await Effect.runPromise(Ref.get(owner.calls))).toBe(2);

    const fresh = await Effect.runPromise(
      mintResumeClaims(frozen, now + 1, { jti: "resume-crash-fresh-000001" }),
    );
    expect(
      await Effect.runPromise(restarted.service.resume(request().operationID, fresh, now + 1)),
    ).toEqual(terminal);
    const beforeConflict = await Effect.runPromise(
      repository.transact((state) => Effect.succeed([JSON.stringify(state), state] as const)),
    );
    const conflict = await Effect.runPromise(
      mintResumeClaims(frozen, now + 1, {
        jti: "resume-crash-exact-000001",
        canonicalQuery: "conflict=1",
      }),
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          restarted.service.resume(request().operationID, conflict, now + 1),
        ),
      ),
    ).toBe(true);
    const afterConflict = await Effect.runPromise(
      repository.transact((state) => Effect.succeed([JSON.stringify(state), state] as const)),
    );
    expect(afterConflict).toBe(beforeConflict);
    expect(await Effect.runPromise(Ref.get(owner.calls))).toBe(2);
  });

  test("rejects every malformed or substituted DirectoryControl resume token before replay claim or OwnerVault", async () => {
    const generic = makeCapabilitySigner({
      purpose: "internal-capability",
      current: { keyID: "resume-current", secret: Redacted.make("resume-current-secret") },
      prior: [],
    });
    const wrongPurpose = async (authority: CapabilityAuthority) =>
      Effect.runPromise(
        generic.sign(
          {
            audience:
              authority === CapabilityAuthority.Directory
                ? CapabilityAudience.Directory
                : CapabilityAudience.OwnerVault,
            authority,
            method: CapabilityMethod.POST,
            path: "/v2/internal/directory/credential-transition/resume",
            canonicalQuery: "",
            bodySHA256: "a".repeat(64),
            ...(authority === CapabilityAuthority.OwnerVault
              ? { ownerID: resolution().ownerID.value, vaultID: resolution().vaultID.value }
              : {}),
            credentialEpoch: 1,
            generationEpoch: 1,
            jti: "resume-control-token-000001",
            ttlSeconds: 60,
          },
          now,
        ),
      );
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly token: (
        transition: NonNullable<DirectoryState["transitions"][string]>,
      ) => Promise<{ readonly value: string }>;
    }> = [
      {
        name: "forged signature",
        token: async (transition) => {
          const valid = await Effect.runPromise(mintResumeClaims(transition, now));
          const final = valid.value.at(-1);
          return { value: `${valid.value.slice(0, -1)}${final === "A" ? "B" : "A"}` };
        },
      },
      {
        name: "expired",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now - 61, { ttlSeconds: 60 })),
      },
      {
        name: "not yet valid",
        token: (transition) => Effect.runPromise(mintResumeClaims(transition, now + 1)),
      },
      {
        name: "Directory purpose",
        token: () => wrongPurpose(CapabilityAuthority.Directory),
      },
      {
        name: "OwnerVault purpose",
        token: () => wrongPurpose(CapabilityAuthority.OwnerVault),
      },
      {
        name: "unknown key",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, {}, unknownInternalResume.signer)),
      },
      {
        name: "method",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { method: CapabilityMethod.GET })),
      },
      {
        name: "path",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { path: "/other" })),
      },
      {
        name: "query",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { canonicalQuery: "x=1" })),
      },
      {
        name: "body hash",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { bodySHA256: "b".repeat(64) })),
      },
      {
        name: "resource",
        token: async (transition) => {
          const valid = await Effect.runPromise(mintResumeClaims(transition, now));
          const payload = valid.value.split(".")[1];
          if (payload === undefined) throw new Error("test setup invalid");
          const decoded = atob(payload.replace(/-/gu, "+").replace(/_/gu, "/"));
          return rawSignedControlPayload(
            decoded.replace('"resource":"credential-transition"', '"resource":"other"'),
          );
        },
      },
      {
        name: "owner",
        token: (transition) =>
          Effect.runPromise(
            mintResumeClaims(transition, now, { ownerID: otherResolution().ownerID.value }),
          ),
      },
      {
        name: "vault",
        token: (transition) =>
          Effect.runPromise(
            mintResumeClaims(transition, now, { vaultID: otherResolution().vaultID.value }),
          ),
      },
      {
        name: "operation",
        token: (transition) =>
          Effect.runPromise(
            mintResumeClaims(transition, now, { operationID: "credential-transition-0002" }),
          ),
      },
      {
        name: "generation",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { generationEpoch: 2 })),
      },
      {
        name: "routing",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { routingEpoch: 2 })),
      },
      {
        name: "credential",
        token: (transition) =>
          Effect.runPromise(mintResumeClaims(transition, now, { credentialEpoch: 2 })),
      },
    ];
    for (const entry of cases) {
      const { calls, memory, service, transition } = await Effect.runPromise(realFrozenResumeSetup);
      const before = JSON.stringify(await Effect.runPromise(Ref.get(memory.state)));
      const exit = await Effect.runPromiseExit(
        service.resume(transition.operationID, await entry.token(transition), now),
      );
      expect(Exit.isFailure(exit), entry.name).toBe(true);
      expect(JSON.stringify(await Effect.runPromise(Ref.get(memory.state))), entry.name).toBe(
        before,
      );
      expect(await Effect.runPromise(Ref.get(calls)), entry.name).toBe(0);
    }
  });

  test("accepts current and prior keys once, then rejects JTI reuse under a distinct token", async () => {
    for (const signer of [realInternalResume.signer, priorInternalResume.signer]) {
      const { calls, memory, service, transition } = await Effect.runPromise(realFrozenResumeSetup);
      const token = await Effect.runPromise(mintResumeClaims(transition, now, {}, signer));
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(service.resume(transition.operationID, token, now)),
        ),
      ).toBe(true);
      expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
      expect(Object.keys((await Effect.runPromise(Ref.get(memory.state))).controlReplays)).toEqual([
        "resume-control-token-000001",
      ]);
    }

    const { calls, memory, service, transition } = await Effect.runPromise(realFrozenResumeSetup);
    const first = await Effect.runPromise(mintResumeClaims(transition, now));
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(service.resume(transition.operationID, first, now)),
      ),
    ).toBe(true);
    const afterFirst = JSON.stringify(await Effect.runPromise(Ref.get(memory.state)));
    const altered = await Effect.runPromise(
      mintResumeClaims(transition, now, { canonicalQuery: "replayed=altered" }),
    );
    const replay = await Effect.runPromiseExit(
      service.resume(transition.operationID, altered, now),
    );
    expect(Exit.isFailure(replay)).toBe(true);
    expect(JSON.stringify(await Effect.runPromise(Ref.get(memory.state)))).toBe(afterFirst);
    expect(await Effect.runPromise(Ref.get(calls))).toBe(1);
  });
});
