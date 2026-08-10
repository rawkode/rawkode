import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import {
  ownerVaultMaximumAccountedBytes,
  makeDurableObjectOwnerVaultStorageRepository,
} from "./repository";

const scope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 };

const nativeState = (): {
  readonly state: DurableObjectStateNative;
  readonly storage: DurableObjectStorageNative & {
    readonly list: (options: {
      readonly prefix: string;
      readonly startAfter?: string;
      readonly limit: number;
    }) => Promise<ReadonlyMap<string, unknown>>;
  };
  readonly entries: Map<string, unknown>;
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
  const storage = {
    ...transaction,
    getAlarm: () => Promise.resolve(null),
    setAlarm: () => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const before = new Map(entries);
      return work(transaction).catch((error: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        return Promise.reject(error);
      });
    },
    list: (options: {
      readonly prefix: string;
      readonly startAfter?: string;
      readonly limit: number;
    }): Promise<ReadonlyMap<string, unknown>> => {
      const selected = [...entries.entries()]
        .filter(([key]) => key.startsWith(options.prefix) && (options.startAfter === undefined || key > options.startAfter))
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, options.limit);
      return Promise.resolve(new Map(selected));
    },
  } satisfies DurableObjectStorageNative & {
    readonly list: (options: {
      readonly prefix: string;
      readonly startAfter?: string;
      readonly limit: number;
    }) => Promise<ReadonlyMap<string, unknown>>;
  };
  return {
    entries,
    storage,
    state: { storage, blockConcurrencyWhile: (work) => work() },
  };
};

const repositoryFor = () => {
  const native = nativeState();
  return {
    native,
    repository: makeDurableObjectOwnerVaultStorageRepository(
      makeDurableObjectBoundary(native.state).storage,
      native.storage,
    ),
  };
};

describe("v2 OwnerVault per-record durable storage", () => {
  test("requires a fresh root identity before any scope-free application row", async () => {
    const { repository, native } = repositoryFor();

    const exit = await Effect.runPromiseExit(
      repository.transact((tx) => tx.put({ category: "device", identifier: "device-1" }, { key: "pk" })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("not_initialized");
    expect([...native.entries.keys()]).toEqual([]);
  });

  test("initializes only one identity and maintains independently bounded records", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx.initialize(scope).pipe(
          Effect.zipRight(
            tx.put({ category: "device", identifier: "device-1" }, { publicKey: "spki" }),
          ),
          Effect.zipRight(tx.get({ category: "device", identifier: "device-1" })),
        ),
      ),
    ).then((stored) => expect(stored?.payload).toEqual({ publicKey: "spki" }));

    const rebind = await Effect.runPromiseExit(
      repository.transact((tx) => tx.initialize({ ...scope, generationEpoch: 2 })),
    );
    expect(Exit.isFailure(rebind)).toBe(true);
    expect(JSON.stringify(rebind)).toContain("identity_conflict");
    expect([...native.entries.keys()].sort()).toEqual([
      "v2.ov/device/device-1",
      "v2.ov/root/accounting",
      "v2.ov/root/identity",
      "v2.ov/root/runtime",
    ]);
  });

  test("rejects nested transactions before a second native transaction can begin", async () => {
    const { repository } = repositoryFor();
    const nested = await Effect.runPromise(
      repository.transact((tx) =>
        tx.initialize(scope).pipe(
          Effect.zipRight(Effect.either(repository.transact(() => Effect.void))),
        ),
      ),
    );

    expect(nested).toMatchObject({
      left: { _tag: "OwnerVaultStorageError", reason: "nested_transaction" },
    });
  });

  test("uses root accounting to refuse admission before writing an over-budget row", async () => {
    const { repository, native } = repositoryFor();
    native.entries.set("v2.ov/root/identity", {
      category: "root.identity",
      version: 1,
      payload: scope,
    });
    native.entries.set("v2.ov/root/runtime", {
      category: "root.runtime",
      version: 1,
      payload: { schemaVersion: 1, migrationJournal: { state: "ready", step: 0 } },
    });
    native.entries.set("v2.ov/root/accounting", {
      category: "root.accounting",
      version: 1,
      payload: { usedBytes: ownerVaultMaximumAccountedBytes },
    });
    const before = JSON.stringify([...native.entries.entries()]);

    const exit = await Effect.runPromiseExit(
      repository.transact((tx) => tx.put({ category: "device", identifier: "device-1" }, { key: "pk" })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("quota_exceeded");
    expect(JSON.stringify([...native.entries.entries()])).toBe(before);
  });

  test("offers only deterministic, bounded inspection pages and never aggregate state", async () => {
    const { repository } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx.initialize(scope).pipe(
          Effect.zipRight(tx.put({ category: "device", identifier: "device-a" }, { key: "a" })),
          Effect.zipRight(tx.put({ category: "device", identifier: "device-b" }, { key: "b" })),
        ),
      ),
    );

    const first = await Effect.runPromise(repository.inspectPage({ category: "device" }, undefined, 1));
    const second = await Effect.runPromise(repository.inspectPage({ category: "device" }, first.nextCursor, 1));
    expect(first.entries.map(([key]) => key)).toEqual(["v2.ov/device/device-a"]);
    expect(second.entries.map(([key]) => key)).toEqual(["v2.ov/device/device-b"]);
  });
});
