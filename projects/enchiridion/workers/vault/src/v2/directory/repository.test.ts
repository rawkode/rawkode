import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { deriveDirectoryInitID } from "./invariants";
import { makeDurableObjectDirectoryRepository } from "./repository";
import type { DirectoryResolution, DirectoryState } from "./types";

const directoryStateKey = "v2.directory.state";

const emptyState = (): DirectoryState => ({
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
const canonicalAlias = (keyID = "current", final = "A"): string =>
  `v2.${keyID}.${"A".repeat(42)}${final}`;
const resolutionFor = (
  binding: string,
  owner = "owner-0000000000000001",
  vault = "vault-0000000000000001",
) => {
  const initID = deriveDirectoryInitID(binding);
  if (initID === undefined) throw new Error("test setup invalid");
  return {
    ownerID: owner,
    vaultID: vault,
    initID,
    generationEpoch: 1,
    activeGeneration: 1,
    routingEpoch: 1,
    credentialEpoch: 1,
    controlEpoch: 1,
  };
};

const nativeState = (
  options: { readonly failPuts?: number } = {},
): { readonly state: DurableObjectStateNative; readonly entries: Map<string, unknown> } => {
  const entries = new Map<string, unknown>();
  let remainingPutFailures = options.failPuts ?? 0;
  const transaction: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      if (remainingPutFailures > 0) {
        remainingPutFailures -= 1;
        return Promise.reject(new Error("storage-put-secret"));
      }
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
      return work(transaction).then(
        (value) => value,
        (error: unknown) => {
          entries.clear();
          for (const [key, value] of before) entries.set(key, value);
          return Promise.reject(error);
        },
      );
    },
  };
  return {
    entries,
    state: { storage, blockConcurrencyWhile: (work) => work() },
  };
};

const committed = (
  state: DirectoryState,
): Effect.Effect<readonly [DirectoryResolution | undefined, DirectoryState], never> =>
  Effect.succeed([undefined, state] as const);

describe("v2 Directory durable repository", () => {
  test("rejects cross-purpose identities, unrelated init IDs, and non-bootstrap epochs before mutation", async () => {
    const binding = canonicalAlias();
    const initID = deriveDirectoryInitID(binding);
    if (initID === undefined) throw new Error("test setup invalid");
    const resolution = {
      ownerID: `owner-${"o".repeat(16)}`,
      vaultID: `vault-${"v".repeat(16)}`,
      initID,
      generationEpoch: 1,
      activeGeneration: 1,
      routingEpoch: 1,
      credentialEpoch: 1,
      controlEpoch: 1,
    };
    for (const corruptResolution of [
      { ...resolution, ownerID: resolution.vaultID },
      { ...resolution, vaultID: resolution.ownerID },
      { ...resolution, initID: `init-${"0".repeat(64)}` },
      { ...resolution, activeGeneration: 2 },
    ]) {
      const native = nativeState();
      native.entries.set(directoryStateKey, {
        aliases: { [binding]: binding },
        bindings: { [binding]: corruptResolution },
        replays: {},
      });
      const before = JSON.stringify([...native.entries.entries()]);
      const repository = makeDurableObjectDirectoryRepository(
        makeDurableObjectBoundary(native.state).storage,
      );
      const exit = await Effect.runPromiseExit(repository.transact((state) => committed(state)));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify([...native.entries.entries()])).toBe(before);
    }
  });

  test("refuses to encode a forged resolution returned by a transaction", async () => {
    const binding = canonicalAlias();
    const initID = deriveDirectoryInitID(binding);
    if (initID === undefined) throw new Error("test setup invalid");
    const native = nativeState();
    const repository = makeDurableObjectDirectoryRepository(
      makeDurableObjectBoundary(native.state).storage,
    );
    const exit = await Effect.runPromiseExit(
      repository.transact((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            aliases: { [binding]: binding },
            bindings: {
              [binding]: {
                ownerID: { value: `owner-${"o".repeat(16)}` },
                vaultID: { value: `vault-${"v".repeat(16)}` },
                initID,
                generationEpoch: 1,
                activeGeneration: 1,
                routingEpoch: 2,
                credentialEpoch: 1,
                controlEpoch: 1,
              },
            },
          },
        ] as const),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(native.entries.has(directoryStateKey)).toBe(false);
  });

  test("rejects corrupt persisted state before the operation and leaves its exact bytes untouched", async () => {
    const native = nativeState();
    const corrupt = {
      aliases: {},
      bindings: {},
      replays: { "replay-request-0001": { fingerprint: "not-a-sha256" } },
    };
    native.entries.set(directoryStateKey, corrupt);
    const before = JSON.stringify([...native.entries.entries()]);
    const repository = makeDurableObjectDirectoryRepository(
      makeDurableObjectBoundary(native.state).storage,
    );

    const exit = await Effect.runPromiseExit(repository.transact((state) => committed(state)));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("repository_unavailable");
    expect(JSON.stringify([...native.entries.entries()])).toBe(before);
  });

  test("rejects noncanonical 32-byte aliases and duplicate durable identities before mutation", async () => {
    const binding = canonicalAlias();
    const alternateTailBits = canonicalAlias("alternate", "B");
    const duplicateOwner = canonicalAlias("duplicate-owner", "Q");
    const duplicateVault = canonicalAlias("duplicate-vault", "g");
    const duplicateInit = canonicalAlias("duplicate-init", "w");
    for (const corrupt of [
      {
        aliases: { [alternateTailBits]: alternateTailBits },
        bindings: { [alternateTailBits]: resolutionFor(binding) },
        replays: {},
      },
      {
        aliases: { [binding]: binding, [duplicateOwner]: duplicateOwner },
        bindings: {
          [binding]: resolutionFor(binding),
          [duplicateOwner]: resolutionFor(
            duplicateOwner,
            "owner-0000000000000001",
            "vault-0000000000000002",
          ),
        },
        replays: {},
      },
      {
        aliases: { [binding]: binding, [duplicateVault]: duplicateVault },
        bindings: {
          [binding]: resolutionFor(binding),
          [duplicateVault]: resolutionFor(
            duplicateVault,
            "owner-0000000000000002",
            "vault-0000000000000001",
          ),
        },
        replays: {},
      },
      {
        aliases: { [binding]: binding, [duplicateInit]: duplicateInit },
        bindings: {
          [binding]: resolutionFor(binding),
          [duplicateInit]: {
            ...resolutionFor(duplicateInit),
            initID: deriveDirectoryInitID(binding),
          },
        },
        replays: {},
      },
    ]) {
      const native = nativeState();
      native.entries.set(directoryStateKey, corrupt);
      const before = JSON.stringify([...native.entries.entries()]);
      const repository = makeDurableObjectDirectoryRepository(
        makeDurableObjectBoundary(native.state).storage,
      );
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(repository.transact((state) => committed(state))),
        ),
      ).toBe(true);
      expect(JSON.stringify([...native.entries.entries()])).toBe(before);
    }
  });

  test("rejects over-retained forged replay state before mutation", async () => {
    const binding = canonicalAlias();
    const resolution = resolutionFor(binding);
    for (const replay of [
      { fingerprint: "a".repeat(64), expiresAt: 10, retainUntil: 311, resolution },
    ]) {
      const native = nativeState();
      native.entries.set(directoryStateKey, {
        aliases: { [binding]: binding },
        bindings: { [binding]: resolution },
        replays: { "replay-request-0001": replay },
      });
      const before = JSON.stringify([...native.entries.entries()]);
      const repository = makeDurableObjectDirectoryRepository(
        makeDurableObjectBoundary(native.state).storage,
      );
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(repository.transact((state) => committed(state))),
        ),
      ).toBe(true);
      expect(JSON.stringify([...native.entries.entries()])).toBe(before);
    }
  });

  test("rolls back a storage precommit failure and the next retry commits cleanly", async () => {
    const native = nativeState({ failPuts: 1 });
    const repository = makeDurableObjectDirectoryRepository(
      makeDurableObjectBoundary(native.state).storage,
    );
    const initial = emptyState();

    const first = await Effect.runPromiseExit(
      repository.transact((state) => committed({ ...state })),
    );
    expect(Exit.isFailure(first)).toBe(true);
    expect(JSON.stringify(first)).toContain("unavailable");
    expect(native.entries.size).toBe(0);

    await Effect.runPromise(repository.transact((state) => committed({ ...state, ...initial })));
    expect(native.entries.has(directoryStateKey)).toBe(true);
  });

  test("rejects forged control replay capacity, chronology, and fingerprints before any transaction callback", async () => {
    const controlReplay = (operationID: string) => ({
      operationID,
      fingerprint: "a".repeat(64),
      expiresAt: 100,
      retainUntil: 400,
    });
    const overflowing = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => {
        const operationID = `control-replay-${index.toString().padStart(4, "0")}`;
        return [operationID, controlReplay(operationID)];
      }),
    );
    for (const controlReplays of [
      overflowing,
      { "control-replay-0000": { ...controlReplay("control-replay-0000"), retainUntil: 401 } },
      {
        "control-replay-0000": {
          ...controlReplay("control-replay-0000"),
          fingerprint: "not-a-digest",
        },
      },
    ]) {
      const native = nativeState();
      native.entries.set(directoryStateKey, {
        ...emptyState(),
        controlReplays,
      });
      const before = JSON.stringify([...native.entries.entries()]);
      let callbackInvoked = false;
      const repository = makeDurableObjectDirectoryRepository(
        makeDurableObjectBoundary(native.state).storage,
      );
      const exit = await Effect.runPromiseExit(
        repository.transact((state) =>
          Effect.sync(() => {
            callbackInvoked = true;
            return [undefined, state] as const;
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(callbackInvoked).toBe(false);
      expect(JSON.stringify([...native.entries.entries()])).toBe(before);
    }
  });
});
