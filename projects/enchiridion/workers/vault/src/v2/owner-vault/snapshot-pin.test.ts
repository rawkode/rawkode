import { describe, expect, test } from "bun:test";
import {
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  makeDurableObjectBoundary,
} from "@enchiridion/runtime";
import { Effect, Exit } from "effect";
import { ownerVaultBackupDigest } from "./backup-canonical";
import { ownerVaultCatalogCanonicalBytes, ownerVaultCatalogDigest } from "./catalog";
import { makeDurableObjectOwnerVaultStorageRepository } from "./repository";
import { makeOwnerVaultSnapshotPinController } from "./snapshot-pin";

const scope = { ownerID: "owner-1", vaultID: "vault-1", generationEpoch: 1 } as const;
const root = { ...scope, namespaceState: "PRIVATE" } as const;
const backupID = "snapshot-pin-0001";
const alarmSentinel = 1_725_000_000_000;

const nativeState = () => {
  const entries = new Map<string, unknown>();
  let alarm: number | null = null;
  let durablePrestateReadKeysForNextTransaction: ReadonlySet<string> | undefined;
  const operations: DurableObjectTransactionNative = {
    get: (key) => Promise.resolve(entries.get(key)),
    put: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(entries.delete(key)),
    getAlarm: () => Promise.resolve(alarm),
    setAlarm: (next) => {
      alarm = next;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarm = null;
      return Promise.resolve();
    },
  };
  const storage: DurableObjectStorageNative = {
    ...operations,
    transaction: <A>(work: (inside: DurableObjectTransactionNative) => Promise<A>) => {
      const durablePrestateReadKeys = durablePrestateReadKeysForNextTransaction;
      durablePrestateReadKeysForNextTransaction = undefined;
      const before = new Map(entries);
      const beforeAlarm = alarm;
      const transaction: DurableObjectTransactionNative = {
        get: (key) =>
          Promise.resolve(durablePrestateReadKeys?.has(key) ? before.get(key) : entries.get(key)),
        put: operations.put,
        delete: operations.delete,
        getAlarm: operations.getAlarm,
        setAlarm: operations.setAlarm,
        deleteAlarm: operations.deleteAlarm,
      };
      return work(transaction).catch((error: unknown) => {
        entries.clear();
        for (const [key, value] of before) entries.set(key, value);
        alarm = beforeAlarm;
        return Promise.reject(error);
      });
    },
  };
  const state: DurableObjectStateNative = { storage, blockConcurrencyWhile: (work) => work() };
  const repository = () =>
    makeDurableObjectOwnerVaultStorageRepository(makeDurableObjectBoundary(state).storage, storage);
  return {
    entries,
    alarm: () => alarm,
    setAlarm: (next: number) => {
      alarm = next;
    },
    requireDurablePrestateReadsForNextTransaction: (...keys: readonly string[]) => {
      durablePrestateReadKeysForNextTransaction = new Set(keys);
    },
    repository,
  };
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
  native.setAlarm(alarmSentinel);
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

  test("C2 terminal pin finalization rolls back its pin and retention rows on a fragment fault", async () => {
    const { native, repository, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    const manifest = ownerVaultBackupDigest(new TextEncoder().encode("c2-terminal-manifest"));
    const before = new Map(native.entries);
    const beforeAlarm = native.alarm();
    const failed = await Effect.runPromiseExit(
      repository.transact((tx) =>
        controller
          .finalizeSnapshotInTx(tx, pin, manifest)
          .pipe(
            Effect.zipRight(
              Effect.fail({ _tag: "OwnerVaultStorageError", reason: "state_corrupt" } as const),
            ),
          ),
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(native.entries).toEqual(before);
    expect(native.alarm()).toBe(beforeAlarm);
  });

  test("C2 finalization combines completion and retention release from one durable prestate", async () => {
    const { native, repository, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    const manifest = ownerVaultBackupDigest(new TextEncoder().encode("c2-terminal-manifest"));
    const before = new Map(native.entries);
    const beforeAlarm = native.alarm();
    const pinKey = `v2.ov/backup/pin/${backupID}`;
    const retentionKey = "v2.ov/catalog/retention/00000000000000000001";
    const journalKey = `v2.ov/backup/gc-journal/${backupID}`;

    native.requireDurablePrestateReadsForNextTransaction(pinKey, retentionKey);
    await Effect.runPromise(
      repository.transact((tx) => controller.finalizeSnapshotInTx(tx, pin, manifest)),
    );

    expect(native.entries.get(pinKey)).toMatchObject({
      category: "backup.pin",
      version: 1,
      payload: { ...pin, state: "COMPLETED", manifestDigest: manifest, retained: false },
    });
    expect(native.entries.get(retentionKey)).toEqual({
      category: "catalog.retention",
      version: 1,
      payload: { pinCount: 0 },
    });
    expect(native.entries.get(journalKey)).toEqual({
      category: "backup.gc-journal",
      version: 1,
      payload: { backupID, catalogRevision: 1, nextOrdinal: 0 },
    });
    expect(native.alarm()).toBe(beforeAlarm);
    const changed = [...native.entries.keys()].filter(
      (key) => JSON.stringify(native.entries.get(key)) !== JSON.stringify(before.get(key)),
    );
    expect(changed).toEqual(["v2.ov/root/accounting", pinKey, retentionKey, journalKey]);
    expect(native.entries.get("v2.ov/root/accounting")).toEqual({
      category: "root.accounting",
      version: 1,
      payload: { usedBytes: 2256 },
    });
    for (const [key, value] of before) {
      if (!new Set(["v2.ov/root/accounting", pinKey, retentionKey, journalKey]).has(key))
        expect(native.entries.get(key)).toEqual(value);
    }
  });

  test("C2 finalization releases a retained completed pin from its durable prestate", async () => {
    const completed = await setup();
    const completedPin = await Effect.runPromise(
      completed.controller.beginSnapshot(scope, backupID),
    );
    const completedManifest = ownerVaultBackupDigest(
      new TextEncoder().encode("completed-retained"),
    );
    await Effect.runPromise(completed.controller.completeSnapshot(completedPin, completedManifest));
    const beforeAlarm = completed.native.alarm();
    await Effect.runPromise(
      completed.repository.transact((tx) =>
        completed.controller.finalizeSnapshotInTx(tx, completedPin, completedManifest),
      ),
    );
    expect(completed.native.entries.get(`v2.ov/backup/pin/${backupID}`)).toMatchObject({
      payload: { state: "COMPLETED", manifestDigest: completedManifest, retained: false },
    });
    expect(
      completed.native.entries.get("v2.ov/catalog/retention/00000000000000000001"),
    ).toMatchObject({ payload: { pinCount: 0 } });
    expect(completed.native.alarm()).toBe(beforeAlarm);
  });

  test("C2 finalization retries exactly and fails closed for divergent or corrupt durable state", async () => {
    const { native, repository, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));
    const manifest = ownerVaultBackupDigest(new TextEncoder().encode("c2-retry-manifest"));
    await Effect.runPromise(
      repository.transact((tx) => controller.finalizeSnapshotInTx(tx, pin, manifest)),
    );
    const completed = new Map(native.entries);
    const completedAlarm = native.alarm();

    await Effect.runPromise(
      repository.transact((tx) => controller.finalizeSnapshotInTx(tx, pin, manifest)),
    );
    expect(native.entries).toEqual(completed);
    expect(native.alarm()).toBe(completedAlarm);
    const restarted = makeOwnerVaultSnapshotPinController(native.repository());
    await Effect.runPromise(
      native.repository().transact((tx) => restarted.finalizeSnapshotInTx(tx, pin, manifest)),
    );
    expect(native.entries).toEqual(completed);
    expect(native.alarm()).toBe(completedAlarm);

    const divergent = ownerVaultBackupDigest(new TextEncoder().encode("other-manifest"));
    for (const attempted of [divergent, "not-a-digest"]) {
      const failed = await Effect.runPromiseExit(
        repository.transact((tx) => controller.finalizeSnapshotInTx(tx, pin, attempted)),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      expect(native.entries).toEqual(completed);
      expect(native.alarm()).toBe(completedAlarm);
    }

    const retained = await Effect.runPromise(controller.beginSnapshot(scope, "snapshot-pin-0002"));
    const retainedRow = native.entries.get("v2.ov/backup/pin/snapshot-pin-0002") as {
      readonly payload: { readonly catalogRevision: number };
    };
    const retentionKey = `v2.ov/catalog/retention/${String(retainedRow.payload.catalogRevision).padStart(20, "0")}`;
    native.entries.delete(retentionKey);
    const missingRetention = new Map(native.entries);
    const missingAlarm = native.alarm();
    const missing = await Effect.runPromiseExit(
      repository.transact((tx) =>
        controller.finalizeSnapshotInTx(
          tx,
          retained,
          ownerVaultBackupDigest(new TextEncoder().encode("retention-corrupt")),
        ),
      ),
    );
    expect(Exit.isFailure(missing)).toBe(true);
    expect(native.entries).toEqual(missingRetention);
    expect(native.alarm()).toBe(missingAlarm);

    const malformedSetup = await setup();
    const malformedPin = await Effect.runPromise(
      malformedSetup.controller.beginSnapshot(scope, "snapshot-pin-0003"),
    );
    const malformedPinRow = malformedSetup.native.entries.get(
      "v2.ov/backup/pin/snapshot-pin-0003",
    ) as { readonly payload: { readonly catalogRevision: number } };
    const malformedRetentionKey = `v2.ov/catalog/retention/${String(malformedPinRow.payload.catalogRevision).padStart(20, "0")}`;
    const retention = malformedSetup.native.entries.get(malformedRetentionKey) as {
      readonly category: string;
      readonly version: number;
    };
    malformedSetup.native.entries.set(malformedRetentionKey, {
      ...retention,
      payload: { pinCount: -1 },
    });
    const malformedRetention = new Map(malformedSetup.native.entries);
    const malformedAlarm = malformedSetup.native.alarm();
    const malformed = await Effect.runPromiseExit(
      malformedSetup.repository.transact((tx) =>
        malformedSetup.controller.finalizeSnapshotInTx(
          tx,
          malformedPin,
          ownerVaultBackupDigest(new TextEncoder().encode("malformed-retention")),
        ),
      ),
    );
    expect(Exit.isFailure(malformed)).toBe(true);
    expect(malformedSetup.native.entries).toEqual(malformedRetention);
    expect(malformedSetup.native.alarm()).toBe(malformedAlarm);
  });

  test("C2 finalization fails closed for illegal OPEN pin state correlations", async () => {
    const unretained = await setup();
    const unretainedPin = await Effect.runPromise(
      unretained.controller.beginSnapshot(scope, backupID),
    );
    const pinKey = `v2.ov/backup/pin/${backupID}`;
    const unretainedRow = unretained.native.entries.get(pinKey) as {
      readonly category: string;
      readonly version: number;
      readonly payload: Readonly<Record<string, unknown>>;
    };
    unretained.native.entries.set(pinKey, {
      ...unretainedRow,
      payload: { ...unretainedRow.payload, retained: false },
    });
    const unretainedBefore = new Map(unretained.native.entries);
    const unretainedAlarm = unretained.native.alarm();
    const unretainedExit = await Effect.runPromiseExit(
      unretained.repository.transact((tx) =>
        unretained.controller.finalizeSnapshotInTx(
          tx,
          unretainedPin,
          ownerVaultBackupDigest(new TextEncoder().encode("illegal-open-unretained")),
        ),
      ),
    );
    expect(Exit.isFailure(unretainedExit)).toBe(true);
    expect(unretained.native.entries).toEqual(unretainedBefore);
    expect(unretained.native.alarm()).toBe(unretainedAlarm);

    const manifested = await setup();
    const manifestedPin = await Effect.runPromise(
      manifested.controller.beginSnapshot(scope, backupID),
    );
    const manifestedRow = manifested.native.entries.get(pinKey) as {
      readonly category: string;
      readonly version: number;
      readonly payload: Readonly<Record<string, unknown>>;
    };
    manifested.native.entries.set(pinKey, {
      ...manifestedRow,
      payload: {
        ...manifestedRow.payload,
        manifestDigest: ownerVaultBackupDigest(new TextEncoder().encode("corrupt-open-manifest")),
      },
    });
    const manifestedBefore = new Map(manifested.native.entries);
    const manifestedAlarm = manifested.native.alarm();
    const manifestedExit = await Effect.runPromiseExit(
      manifested.repository.transact((tx) =>
        manifested.controller.finalizeSnapshotInTx(
          tx,
          manifestedPin,
          ownerVaultBackupDigest(new TextEncoder().encode("attempted-open-manifest")),
        ),
      ),
    );
    expect(Exit.isFailure(manifestedExit)).toBe(true);
    expect(manifested.native.entries).toEqual(manifestedBefore);
    expect(manifested.native.alarm()).toBe(manifestedAlarm);
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

  test("fails closed after restart when a digest-consistent catalog names an out-of-registry category", async () => {
    const { native, controller } = await setup();
    const pin = await Effect.runPromise(controller.beginSnapshot(scope, backupID));

    type Row<P> = { readonly category: string; readonly version: number; readonly payload: P };
    const stored = <P>(key: string): Row<P> => {
      const value = native.entries.get(key);
      if (value === undefined) throw new Error(`missing row ${key}`);
      return value as Row<P>;
    };
    const pageKey = "v2.ov/catalog/page/00000000000000000001-0000";
    const rootKey = "v2.ov/catalog/root/00000000000000000001";
    const pinKey = `v2.ov/backup/pin/${backupID}`;
    const currentKey = [...native.entries.keys()].find((key) => key.includes("catalog/current"));
    if (currentKey === undefined) throw new Error("missing catalog current row");
    const page = stored<{
      readonly entries: readonly Record<string, unknown>[];
      readonly digest: string;
    }>(pageKey);
    const root = stored<
      Record<string, unknown> & { readonly pages: readonly Record<string, unknown>[] }
    >(rootKey);
    const pinRow = stored<Record<string, unknown>>(pinKey);
    const current = stored<Record<string, unknown>>(currentKey);

    // Rebuild a fully digest-consistent catalog chain whose only defect is a
    // category outside the closed registry: every hash gate passes, so only
    // the closed-set membership decode can reject it.
    const entries = page.payload.entries.map((entry, index) =>
      index === 0 ? { ...entry, category: "mystery.category" } : entry,
    );
    const digest = ownerVaultCatalogDigest(entries);
    const bytes =
      digest === undefined
        ? undefined
        : ownerVaultCatalogCanonicalBytes({ entries, digest })?.byteLength;
    if (digest === undefined || bytes === undefined) throw new Error("catalog encoding failed");
    const rootPayload = {
      ...root.payload,
      pages: root.payload.pages.map((descriptor) => ({ ...descriptor, digest, bytes })),
      catalogDigest: digest,
      highWaterMark: digest,
    };
    const rootDigest = ownerVaultCatalogDigest(rootPayload);
    if (rootDigest === undefined) throw new Error("root encoding failed");
    native.entries.set(pageKey, { ...page, payload: { entries, digest } });
    native.entries.set(rootKey, { ...root, payload: rootPayload });
    native.entries.set(pinKey, {
      ...pinRow,
      payload: { ...pinRow.payload, rootDigest, catalogDigest: digest, highWaterMark: digest },
    });
    native.entries.set(currentKey, { ...current, payload: { ...current.payload, rootDigest } });

    const restarted = makeOwnerVaultSnapshotPinController(native.repository(), {
      makePinProof: () => "pin-proof-which-is-long-enough",
    });
    const before = new Map(native.entries);
    const exit = await Effect.runPromiseExit(
      restarted.readSnapshotPage(
        { ...pin, catalogDigest: digest, highWaterMark: digest },
        undefined,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // Nothing was archived or published, and no manifest digest completed.
    expect(native.entries).toEqual(before);
    expect(
      await Effect.runPromise(restarted.completedManifestDigest(scope, backupID)),
    ).toBeUndefined();
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
