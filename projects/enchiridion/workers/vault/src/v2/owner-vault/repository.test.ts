import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { ownerVaultCatalogDigest } from "./catalog";
import {
  OwnerVaultInspectionPurpose,
  makeDurableObjectOwnerVaultStorageRepository,
  ownerVaultAccountingEnvelopeSafetyBytes,
  ownerVaultAdmissionReserveBytes,
  ownerVaultIsolateCeilingBytes,
  ownerVaultMaximumAccountedBytes,
} from "./repository";

const scope = {
  ownerID: "owner-1",
  vaultID: "vault-1",
  generationEpoch: 1,
  namespaceState: "PRIVATE",
} as const;

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
        .filter(
          ([key]) =>
            key.startsWith(options.prefix) &&
            (options.startAfter === undefined || key > options.startAfter),
        )
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
      repository.transact((tx) =>
        tx.put({ category: "device", identifier: "device-1" }, { key: "pk" }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("not_initialized");
    expect([...native.entries.keys()]).toEqual([]);
  });

  test("initializes only one identity and maintains independently bounded records", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .initialize(scope)
          .pipe(
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
      "v2.ov/catalog/current",
      "v2.ov/catalog/page/00000000000000000001-0000",
      "v2.ov/catalog/root/00000000000000000001",
      "v2.ov/device/device-1",
      "v2.ov/root/accounting",
      "v2.ov/root/identity",
      "v2.ov/root/runtime",
    ]);
  });

  test("requires the exact immutable target root, not a scope-shaped authority row", async () => {
    const { repository, native } = repositoryFor();
    const invalidEpoch = await Effect.runPromiseExit(
      repository.transact((tx) => tx.initialize({ ...scope, generationEpoch: 0 })),
    );
    expect(Exit.isFailure(invalidEpoch)).toBe(true);
    expect(JSON.stringify(invalidEpoch)).toContain("invalid_record");
    expect([...native.entries.keys()]).toEqual([]);

    await Effect.runPromise(repository.transact((tx) => tx.initialize(scope)));
    const stateChange = await Effect.runPromiseExit(
      repository.transact((tx) => tx.initialize({ ...scope, namespaceState: "ACTIVE" })),
    );
    expect(Exit.isFailure(stateChange)).toBe(true);
    expect(JSON.stringify(stateChange)).toContain("identity_conflict");
  });

  test("rejects nested transactions before a second native transaction can begin", async () => {
    const { repository } = repositoryFor();
    const nested = await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .initialize(scope)
          .pipe(Effect.zipRight(Effect.either(repository.transact(() => Effect.void)))),
      ),
    );

    expect(nested).toMatchObject({
      left: { _tag: "OwnerVaultStorageError", reason: "nested_transaction" },
    });
  });

  test("rolls back staged rows and preserves a typed blob domain rejection", async () => {
    const { repository, native } = repositoryFor();
    const exit = await Effect.runPromiseExit(
      repository.transact((tx) =>
        tx.initialize(scope).pipe(
          Effect.zipRight(
            tx.put({ category: "device", identifier: "device-1" }, { publicKey: "spki" }),
          ),
          Effect.zipRight(
            Effect.fail({
              _tag: "OwnerVaultDomainTransactionError" as const,
              reason: "blob_stage_conflict" as const,
            }),
          ),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("OwnerVaultDomainTransactionError");
    expect(JSON.stringify(exit)).toContain("blob_stage_conflict");
    expect([...native.entries.keys()]).toEqual([]);
  });

  test("uses root accounting to refuse admission before writing an over-budget row", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(repository.transact((tx) => tx.initialize(scope)));
    native.entries.set("v2.ov/root/accounting", {
      category: "root.accounting",
      version: 1,
      payload: { usedBytes: ownerVaultMaximumAccountedBytes },
    });
    const before = JSON.stringify([...native.entries.entries()]);

    const exit = await Effect.runPromiseExit(
      repository.transact((tx) =>
        tx.put({ category: "device", identifier: "device-1" }, { key: "pk" }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("quota_exceeded");
    expect(JSON.stringify([...native.entries.entries()])).toBe(before);
  });

  test("retains the full reserve after accounting for the accounting envelope", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(repository.transact((tx) => tx.initialize(scope)));
    const encodedAccountingBytes = new TextEncoder().encode(
      JSON.stringify(native.entries.get("v2.ov/root/accounting")),
    ).byteLength;
    expect(encodedAccountingBytes).toBeLessThanOrEqual(ownerVaultAccountingEnvelopeSafetyBytes);
    expect(
      ownerVaultMaximumAccountedBytes +
        ownerVaultAccountingEnvelopeSafetyBytes +
        ownerVaultAdmissionReserveBytes,
    ).toBe(ownerVaultIsolateCeilingBytes);
    expect(
      ownerVaultMaximumAccountedBytes + encodedAccountingBytes + ownerVaultAdmissionReserveBytes,
    ).toBeLessThanOrEqual(ownerVaultIsolateCeilingBytes);
  });

  test("offers only deterministic, bounded backup pages and never aggregate state", async () => {
    const { repository } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .initialize(scope)
          .pipe(
            Effect.zipRight(tx.put({ category: "device", identifier: "device-a" }, { key: "a" })),
            Effect.zipRight(tx.put({ category: "device", identifier: "device-b" }, { key: "b" })),
          ),
      ),
    );

    const first = await Effect.runPromise(
      repository.inspectPage(
        OwnerVaultInspectionPurpose.BackupSnapshot,
        { category: "device" },
        undefined,
        1,
      ),
    );
    const second = await Effect.runPromise(
      repository.inspectPage(
        OwnerVaultInspectionPurpose.BackupSnapshot,
        { category: "device" },
        first.nextCursor,
        1,
      ),
    );
    expect(first.entries.map(([key]) => key)).toEqual(["v2.ov/device/device-a"]);
    expect(second.entries.map(([key]) => key)).toEqual(["v2.ov/device/device-b"]);
  });

  test("builds a dense immutable catalog from staged snapshot rows and excludes target-local rows", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .initialize(scope)
          .pipe(
            Effect.zipRight(tx.put({ category: "device", identifier: "z" }, { key: "z" })),
            Effect.zipRight(
              tx.put({ category: "nonce", identifier: "local" }, { nonce: "never-backed-up" }),
            ),
            Effect.zipRight(tx.put({ category: "device", identifier: "a" }, { key: "a" })),
          ),
      ),
    );
    const current = native.entries.get("v2.ov/catalog/current") as {
      payload: { catalogRevision: number };
    };
    const root = native.entries.get(
      `v2.ov/catalog/root/${String(current.payload.catalogRevision).padStart(20, "0")}`,
    ) as {
      payload: { pages: readonly { identifier: string }[] };
    };
    const entries = root.payload.pages.flatMap(
      (page) =>
        (
          native.entries.get(`v2.ov/catalog/page/${page.identifier}`) as {
            payload: {
              entries: readonly {
                key: string;
                ordinal: number;
                category: string;
                bytes: number;
                digest: string;
              }[];
            };
          }
        ).payload.entries,
    );
    expect(entries).toEqual([
      {
        key: "v2.ov/device/a",
        ordinal: 0,
        category: "device",
        bytes: expect.any(Number),
        digest: expect.any(String),
      },
      {
        key: "v2.ov/device/z",
        ordinal: 1,
        category: "device",
        bytes: expect.any(Number),
        digest: expect.any(String),
      },
    ]);
    expect(entries.some((entry) => entry.key.includes("nonce"))).toBe(false);
  });

  test("splits catalog pages, replaces roots copy-on-write, and merges after delete", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) => {
        let work = tx.initialize(scope);
        for (let index = 0; index < 130; index += 1)
          work = work.pipe(
            Effect.zipRight(
              tx.put(
                { category: "device", identifier: `d${String(index).padStart(3, "0")}` },
                { key: index },
              ),
            ),
          );
        return work;
      }),
    );
    const currentAfterInsert = native.entries.get("v2.ov/catalog/current") as {
      payload: { catalogRevision: number };
    };
    const rootAfterInsert = native.entries.get(
      `v2.ov/catalog/root/${String(currentAfterInsert.payload.catalogRevision).padStart(20, "0")}`,
    ) as { payload: { pages: readonly unknown[] } };
    expect(rootAfterInsert.payload.pages).toHaveLength(2);
    await Effect.runPromise(
      repository.transact((tx) =>
        Effect.forEach(
          Array.from({ length: 3 }, (_, index) => index),
          (index) =>
            tx.delete({ category: "device", identifier: `d${String(index).padStart(3, "0")}` }),
        ),
      ),
    );
    const currentAfterDelete = native.entries.get("v2.ov/catalog/current") as {
      payload: { catalogRevision: number };
    };
    const rootAfterDelete = native.entries.get(
      `v2.ov/catalog/root/${String(currentAfterDelete.payload.catalogRevision).padStart(20, "0")}`,
    ) as { payload: { pages: readonly unknown[] } };
    expect(currentAfterDelete.payload.catalogRevision).toBe(
      currentAfterInsert.payload.catalogRevision + 1,
    );
    expect(rootAfterDelete.payload.pages).toHaveLength(1);
    expect(
      native.entries.has(
        `v2.ov/catalog/root/${String(currentAfterInsert.payload.catalogRevision).padStart(20, "0")}`,
      ),
    ).toBe(false);
  });

  test("fails closed on catalog corruption and can read an unchanged catalog through a fresh repository", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .initialize(scope)
          .pipe(Effect.zipRight(tx.put({ category: "device", identifier: "a" }, { key: "a" }))),
      ),
    );
    const restarted = makeDurableObjectOwnerVaultStorageRepository(
      makeDurableObjectBoundary(native.state).storage,
      native.storage,
    );
    expect(
      (
        await Effect.runPromise(
          restarted.inspectPage(
            OwnerVaultInspectionPurpose.BackupSnapshot,
            { category: "device" },
            undefined,
            2,
          ),
        )
      ).entries,
    ).toHaveLength(1);
    native.entries.set("v2.ov/catalog/current", {
      category: "catalog.current",
      version: 1,
      payload: { catalogRevision: 1, rootDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    });
    const corrupt = await Effect.runPromiseExit(
      restarted.inspectPage(
        OwnerVaultInspectionPurpose.BackupSnapshot,
        { category: "device" },
        undefined,
        2,
      ),
    );
    expect(Exit.isFailure(corrupt)).toBe(true);
    expect(JSON.stringify(corrupt)).toContain("state_corrupt");
  });

  test("fails closed before any write when a durable catalog page contradicts its root after restart", async () => {
    const { repository, native } = repositoryFor();
    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .initialize(scope)
          .pipe(Effect.zipRight(tx.put({ category: "device", identifier: "a" }, { key: "a" }))),
      ),
    );
    const current = native.entries.get("v2.ov/catalog/current") as {
      payload: { catalogRevision: number };
    };
    const pageKey = `v2.ov/catalog/page/${String(current.payload.catalogRevision).padStart(20, "0")}-0000`;
    expect(native.entries.has(pageKey)).toBe(true);
    // Self-consistent page (its own digest verifies) that no longer matches the
    // pinned root descriptor: decoding alone cannot admit it.
    native.entries.set(pageKey, {
      category: "catalog.page",
      version: 1,
      payload: { entries: [], digest: ownerVaultCatalogDigest([]) },
    });
    const restarted = makeDurableObjectOwnerVaultStorageRepository(
      makeDurableObjectBoundary(native.state).storage,
      native.storage,
    );
    const before = JSON.stringify([...native.entries]);
    const write = await Effect.runPromiseExit(
      restarted.transact((tx) => tx.put({ category: "device", identifier: "b" }, { key: "b" })),
    );
    expect(Exit.isFailure(write)).toBe(true);
    expect(JSON.stringify(write)).toContain("state_corrupt");
    // The corruption is detected before any row, accounting, or catalog mutation.
    expect(JSON.stringify([...native.entries])).toBe(before);
    const inspect = await Effect.runPromiseExit(
      restarted.inspectPage(
        OwnerVaultInspectionPurpose.BackupSnapshot,
        { category: "device" },
        undefined,
        2,
      ),
    );
    expect(Exit.isFailure(inspect)).toBe(true);
    expect(JSON.stringify(inspect)).toContain("state_corrupt");
  });

  test("refuses excluded rows and mismatched inspection purposes", async () => {
    const { repository } = repositoryFor();
    await Effect.runPromise(repository.transact((tx) => tx.initialize(scope)));
    const excluded = await Effect.runPromiseExit(
      repository.inspectPage(
        OwnerVaultInspectionPurpose.BackupSnapshot,
        { category: "blob.accounting" },
        undefined,
        1,
      ),
    );
    const mismatched = await Effect.runPromiseExit(
      repository.inspectPage(
        OwnerVaultInspectionPurpose.RestoreAudit,
        { category: "device" },
        undefined,
        1,
      ),
    );
    expect(Exit.isFailure(excluded)).toBe(true);
    expect(JSON.stringify(excluded)).toContain("inspection_forbidden");
    expect(Exit.isFailure(mismatched)).toBe(true);
    expect(JSON.stringify(mismatched)).toContain("inspection_forbidden");
  });

  test("accepts only the canonical append head tuple", async () => {
    const { repository } = repositoryFor();
    await Effect.runPromise(repository.transact((tx) => tx.initialize(scope)));
    const legacy = await Effect.runPromiseExit(
      repository.transact((tx) => tx.put({ category: "root.log-head" }, { logSequence: 1 })),
    );
    const mixed = await Effect.runPromiseExit(
      repository.transact((tx) =>
        tx.put(
          { category: "append-log.head" },
          { appendLogSequence: 1, appendLogDigest: "a".repeat(64), logSequence: 1 },
        ),
      ),
    );
    expect(Exit.isFailure(legacy)).toBe(true);
    expect(Exit.isFailure(mixed)).toBe(true);
  });
});
