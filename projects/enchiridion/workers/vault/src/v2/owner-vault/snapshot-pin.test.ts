import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { ownerVaultBackupDigest } from "./backup-canonical";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";
import { makeOwnerVaultSnapshotPinController } from "./snapshot-pin";

const scope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 } as const;
const root = { ...scope, namespaceState: "PRIVATE" } as const;
const backupID = "snapshot-pin-0001";

const nativeState = () => {
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
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const before = new Map(entries);
      return work(transaction).catch((error: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        return Promise.reject(error);
      });
    },
  };
  const state: DurableObjectStateNative = { storage, blockConcurrencyWhile: (work) => work() };
  const repository = () =>
    makeDurableObjectOwnerVaultStorageRepository(makeDurableObjectBoundary(state).storage, storage);
  return { entries, repository };
};

const setup = async () => {
  const native = nativeState();
  const repository = native.repository();
  await Effect.runPromise(
    repository.transact((tx) =>
      tx
        .initialize(root)
        .pipe(
          Effect.zipRight(
            tx.put({ category: "device", identifier: "device-a" }, { publicKey: "old" }),
          ),
          Effect.zipRight(
            tx.put({ category: "blob.metadata", identifier: "blob-a" }, { state: "old" }),
          ),
        ),
    ),
  );
  return {
    native,
    repository,
    controller: makeOwnerVaultSnapshotPinController(repository, {
      makePinProof: () => "pin-proof-which-is-long-enough",
    }),
  };
};

describe("OwnerVault durable snapshot pins", () => {
  test("pins an immutable root and resolves COW preimages after concurrent writes", async () => {
    const { repository, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));

    await Effect.runPromise(
      repository.transact((tx) =>
        tx
          .put({ category: "device", identifier: "device-a" }, { publicKey: "new" })
          .pipe(
            Effect.zipRight(
              tx.put({ category: "blob.metadata", identifier: "blob-a" }, { state: "new" }),
            ),
            Effect.zipRight(
              tx.put(
                { category: "append-log.entry", identifier: "00000000000000000001" },
                { payload: "concurrent" },
              ),
            ),
            Effect.zipRight(
              tx.put({ category: "device", identifier: "device-b" }, { publicKey: "concurrent" }),
            ),
          ),
      ),
    );

    const page = await Effect.runPromise(controller.readSnapshotPage(pin, undefined));
    expect(page.entries).toHaveLength(2);
    expect(
      page.entries.find((entry) => entry.address.category === "device")?.record.payload,
    ).toEqual({ publicKey: "old" });
    expect(
      page.entries.find((entry) => entry.address.category === "blob.metadata")?.record.payload,
    ).toEqual({ state: "old" });
  });

  test("restarts from durable rows and replays the exact retained archive pin", async () => {
    const { native, controller } = await setup();
    const first = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    const replay = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    expect(replay).toEqual(first);

    const restarted = native.repository();
    const afterRestart = makeOwnerVaultSnapshotPinController(restarted, {
      makePinProof: () => "another-proof-which-is-long-enough",
    });
    expect(
      (await Effect.runPromise(afterRestart.readSnapshotPage(first, undefined))).entries,
    ).toHaveLength(2);
    const retention = await Effect.runPromise(
      restarted.transact((tx) =>
        tx.get({ category: "catalog.retention", identifier: "00000000000000000001" }),
      ),
    );
    expect(retention?.payload).toEqual({ pinCount: 1 });
  });

  test("rejects legacy or mixed pin proofs rather than reinterpreting a catalog high-water as an append head", async () => {
    const { native, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    const key = "v2.ov/backup/pin/snapshot-pin-0001";
    const stored = native.entries.get(key) as {
      readonly category: string;
      readonly version: number;
      readonly payload: Readonly<Record<string, unknown>>;
    };
    native.entries.set(key, { ...stored, payload: { ...stored.payload, logHead: 0 } });
    const legacy = await Effect.runPromiseExit(controller.beginSnapshot(scope, backupID));
    expect(Exit.isFailure(legacy)).toBe(true);
    native.entries.set(key, {
      ...stored,
      payload: { ...stored.payload, appendLogDigest: "a".repeat(64), appendLogSequence: 0 },
    });
    const mixed = await Effect.runPromiseExit(controller.readSnapshotPage(pin, undefined));
    expect(Exit.isFailure(mixed)).toBe(true);
  });

  test("aborting closes the named archive namespace permanently", async () => {
    const { controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    await Effect.runPromise(controller.abortSnapshot(pin));
    const replay = await Effect.runPromiseExit(controller.beginSnapshot(scope, backupID));
    expect(Exit.isFailure(replay)).toBe(true);
  });

  test("keeps a failed completion OPEN, then records one exact immutable-manifest digest", async () => {
    const { controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    const bad = await Effect.runPromiseExit(controller.completeSnapshot(pin, "not-a-digest"));
    expect(Exit.isFailure(bad)).toBe(true);
    expect(
      (await Effect.runPromise(controller.readSnapshotPage(pin, undefined))).entries,
    ).toHaveLength(2);

    const manifest = ownerVaultBackupDigest(new TextEncoder().encode("immutable manifest"));
    await Effect.runPromise(controller.completeSnapshot(pin, manifest));
    await Effect.runPromise(controller.completeSnapshot(pin, manifest));
    await Effect.runPromise(controller.releaseSnapshot(pin));
  });

  test("recovers only the terminal manifest digest after response loss and restart", async () => {
    const { native, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    expect(
      await Effect.runPromise(controller.completedManifestDigest(scope, backupID)),
    ).toBeUndefined();

    const manifest = ownerVaultBackupDigest(
      new TextEncoder().encode("response was lost after completion"),
    );
    await Effect.runPromise(controller.completeSnapshot(pin, manifest));
    await Effect.runPromise(controller.releaseSnapshot(pin));

    const restarted = makeOwnerVaultSnapshotPinController(native.repository());
    expect(await Effect.runPromise(restarted.completedManifestDigest(scope, backupID))).toBe(
      manifest,
    );
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          restarted.completedManifestDigest({ ...scope, generationEpoch: 2 }, backupID),
        ),
      ),
    ).toBe(true);
  });

  test("garbage collects retained preimages and historical catalog rows in bounded transactions", async () => {
    const { native, repository, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    await Effect.runPromise(
      repository.transact((tx) =>
        tx.put({ category: "device", identifier: "device-a" }, { publicKey: "new" }),
      ),
    );
    expect([...native.entries.keys()].some((key) => key.startsWith("v2.ov/backup/preimage/"))).toBe(
      true,
    );

    await Effect.runPromise(controller.abortSnapshot(pin));
    expect(await Effect.runPromise(controller.collectGarbage(backupID))).toBe(true);
    expect([...native.entries.keys()].some((key) => key.startsWith("v2.ov/backup/preimage/"))).toBe(
      false,
    );
    expect(native.entries.has("v2.ov/catalog/root/00000000000000000001")).toBe(false);
  });

  test("fails closed when a retained immutable root is corrupted", async () => {
    const { native, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    native.entries.set("v2.ov/catalog/root/00000000000000000001", {
      category: "catalog.root",
      version: 1,
      payload: { broken: true },
    });
    const result = await Effect.runPromiseExit(controller.readSnapshotPage(pin, undefined));
    expect(Exit.isFailure(result)).toBe(true);
  });
});
