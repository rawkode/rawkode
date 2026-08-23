import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import {
  collection,
  createEffectTypedStorage,
  IndexConflictError,
  type Subscriber,
} from "../src/index.js";
import type { TestStorageDurableObject } from "./worker.js";

// Tests run against a real `DurableObjectStorage` (obtained via `runInDurableObject`), not a
// mock, so they exercise this package's actual runtime dependency directly. Each `describe`
// block uses its own DO instance name so tests don't share state.

const testEnv = env as unknown as {
  TEST_STORAGE: DurableObjectNamespace<TestStorageDurableObject>;
};

function withStorage<T>(
  instanceName: string,
  f: (storage: DurableObjectStorage) => Promise<T> | T,
): Promise<T> {
  const stub = testEnv.TEST_STORAGE.getByName(instanceName);
  // `runInDurableObject`'s callback receives the live `DurableObjectState` as its second
  // argument, so this reaches real DO storage without needing to widen `ctx`'s visibility on the
  // test DO class.
  return runInDurableObject(stub, async (_instance, state) => f(state.storage));
}

type User = {
  uid: number;
  name: string;
  level: number;
  emails: string[];
  groups: string[];
};

const ALICE: User = { uid: 45, name: "alice", level: 8, emails: ["alice@example.com"], groups: ["everyone", "admin"] };
const BOB: User = { uid: 284, name: "bob", level: 4, emails: ["bob@example.com", "robert@example.com"], groups: ["everyone"] };
const CAROL: User = { uid: 2, name: "carol", level: 8, emails: [], groups: ["everyone", "admin"] };
const DAVE: User = { uid: 17, name: "dave", level: 1, emails: ["dave@example.com", "david@example.com"], groups: ["everyone", "interns"] };

describe("createEffectTypedStorage: singletons", () => {
  it("supports get/put as Effects, and get() returns the default before any put()", async () => {
    await withStorage("singletons-basic", async (storage) => {
      const ts = createEffectTypedStorage(storage, { singletons: { counter: 0, name: "Alice" } });

      expect(await Effect.runPromise(ts.counter.get())).toStrictEqual(0);
      expect(await Effect.runPromise(ts.name.get())).toStrictEqual("Alice");

      await Effect.runPromise(ts.counter.put(123));

      expect(await Effect.runPromise(ts.counter.get())).toStrictEqual(123);
      expect(await Effect.runPromise(ts.name.get())).toStrictEqual("Alice");
    });
  });

  it("subscribe() notifies for the scope's lifetime, then stops once the scope closes", async () => {
    await withStorage("singletons-subscribe", async (storage) => {
      const ts = createEffectTypedStorage(storage, { singletons: { counter: 0 } });

      let lastValue = -1;
      const subscriber = { update: (value: number) => { lastValue = value; } };

      // Put once before subscribing: should not notify (nothing subscribed yet).
      await Effect.runPromise(ts.counter.put(1));
      expect(lastValue).toStrictEqual(-1);

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ts.counter.subscribe(subscriber);

            yield* ts.counter.put(123);
            expect(lastValue).toStrictEqual(123);

            yield* ts.counter.put(321);
            expect(lastValue).toStrictEqual(321);
          }),
        ),
      );

      // Scope closed: the resource-release should have unsubscribed automatically, with no
      // separate `unsubscribe()` call required.
      await Effect.runPromise(ts.counter.put(555));
      expect(lastValue).toStrictEqual(321);
    });
  });
});

describe("createEffectTypedStorage: collection with string primary key", () => {
  it("put/get/list/delete round-trip through Effect, in primary-key order", async () => {
    await withStorage("collection-string-pk", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: { users: collection<User>()({ primaryKey: "name" }) },
      });

      expect(await Effect.runPromise(ts.users.list())).toStrictEqual([]);

      // Put out of order to confirm list() comes back in key order.
      await Effect.runPromise(ts.users.put(BOB));
      await Effect.runPromise(ts.users.put(DAVE));
      await Effect.runPromise(ts.users.put(CAROL));
      await Effect.runPromise(ts.users.put(ALICE));

      expect(await Effect.runPromise(ts.users.get("alice"))).toStrictEqual(ALICE);
      expect(await Effect.runPromise(ts.users.get("eve"))).toStrictEqual(undefined);

      expect(await Effect.runPromise(ts.users.list())).toStrictEqual([ALICE, BOB, CAROL, DAVE]);
      expect(await Effect.runPromise(ts.users.list({ reverse: true }))).toStrictEqual([DAVE, CAROL, BOB, ALICE]);
      expect(await Effect.runPromise(ts.users.list({ start: "bob", end: "dave" }))).toStrictEqual([BOB, CAROL]);

      expect(await Effect.runPromise(ts.users.delete("carol"))).toStrictEqual(true);
      expect(await Effect.runPromise(ts.users.delete("carol"))).toStrictEqual(false);
      expect(await Effect.runPromise(ts.users.list())).toStrictEqual([ALICE, BOB, DAVE]);

      // The raw stored record has its primary-key property nulled out (dedup optimization) —
      // confirms the ported `KvPrefixedView` key-erasure mechanic still runs under the Effect
      // wrapper, exactly as in the original.
      expect(storage.kv.get("users:alice")).toStrictEqual({ ...ALICE, name: null });
    });
  });

  it("surfaces a thrown key-encoding error as a typed StorageError, not a thrown exception", async () => {
    await withStorage("collection-bad-key", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: { users: collection<User>()({ primaryKey: "uid" }) },
      });

      // 1.5 is not a valid integer key -> the ported `keyString()` throws a TypeError deep inside
      // `put()`. Confirm it comes back as a typed Effect failure (`StorageError`) rather than an
      // uncaught throw out of an otherwise-Effect-returning method.
      const exit = await Effect.runPromiseExit(ts.users.put({ ...ALICE, uid: 1.5 }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
        expect(failure?._tag).toStrictEqual("StorageError");
      }
    });
  });
});

describe("createEffectTypedStorage: unique index", () => {
  it("maintains the index transactionally and rejects conflicts as a typed IndexConflictError", async () => {
    await withStorage("collection-unique-index", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: {
          users: collection<User>()({
            primaryKey: "uid",
            uniqueIndexes: { byName: (u: User) => u.name },
          }),
        },
      });

      await Effect.runPromise(ts.users.put(ALICE));
      await Effect.runPromise(ts.users.put(BOB));

      expect(await Effect.runPromise(ts.users.byName.get("alice"))).toStrictEqual(ALICE);
      expect(await Effect.runPromise(ts.users.byName.get("eve"))).toStrictEqual(undefined);
      expect(await Effect.runPromise(ts.users.byName.list())).toStrictEqual([ALICE, BOB]);

      // Renaming updates the index transactionally.
      const roberto = { ...BOB, name: "roberto" };
      await Effect.runPromise(ts.users.put(roberto));
      expect(await Effect.runPromise(ts.users.byName.get("bob"))).toStrictEqual(undefined);
      expect(await Effect.runPromise(ts.users.byName.get("roberto"))).toStrictEqual(roberto);

      // Conflicting rename: a new record whose index key collides with ALICE's.
      const exit = await Effect.runPromiseExit(ts.users.put({ ...DAVE, name: "alice" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause._tag === "Fail" && exit.cause.error).toBeInstanceOf(IndexConflictError);
        if (exit.cause._tag === "Fail" && exit.cause.error instanceof IndexConflictError) {
          expect(exit.cause.error.collection).toStrictEqual("users");
          expect(exit.cause.error.index).toStrictEqual("byName");
          expect(exit.cause.error.conflictingPrimaryKey).toStrictEqual(String(ALICE.uid));
        }
      }
      // Rejected put must not have partially applied.
      expect(await Effect.runPromise(ts.users.byName.get("alice"))).toStrictEqual(ALICE);
      expect(await Effect.runPromise(ts.users.get(DAVE.uid))).toStrictEqual(undefined);
    });
  });
});

describe("createEffectTypedStorage: non-unique index (array-valued)", () => {
  it("supports get/list/dedupe/delete across multiple records per key", async () => {
    await withStorage("collection-non-unique-index", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: {
          users: collection<User>()({
            primaryKey: "name",
            nonUniqueIndexes: { byGroup: (u: User) => u.groups },
          }),
        },
      });

      await Effect.runPromise(ts.users.put(ALICE));
      await Effect.runPromise(ts.users.put(BOB));
      await Effect.runPromise(ts.users.put(CAROL));
      await Effect.runPromise(ts.users.put(DAVE));

      expect(await Effect.runPromise(ts.users.byGroup.get("admin"))).toStrictEqual([ALICE, CAROL]);
      expect(await Effect.runPromise(ts.users.byGroup.get("nobody"))).toStrictEqual([]);

      expect(await Effect.runPromise(ts.users.byGroup.list({ dedupe: true }))).toStrictEqual([ALICE, CAROL, BOB, DAVE]);

      expect(await Effect.runPromise(ts.users.byGroup.delete("admin"))).toStrictEqual(2);
      expect(await Effect.runPromise(ts.users.byGroup.delete("admin"))).toStrictEqual(0);
      expect(await Effect.runPromise(ts.users.byGroup.get("admin"))).toStrictEqual([]);
      // Deleting via the index deletes the underlying records too.
      expect(await Effect.runPromise(ts.users.get("alice"))).toStrictEqual(undefined);
      expect(await Effect.runPromise(ts.users.get("bob"))).toStrictEqual(BOB);
    });
  });
});

describe("createEffectTypedStorage: collection subscribe()", () => {
  it("notifies add/update/remove for the scope's lifetime, then stops once the scope closes", async () => {
    await withStorage("collection-subscribe", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: { users: collection<User>()({ primaryKey: "name" }) },
      });

      const events: string[] = [];
      const subscriber: Subscriber<User> = {
        add: (record) => events.push(`add:${record.name}`),
        update: (oldRecord, newRecord) => events.push(`update:${oldRecord.name}->${newRecord.name}`),
        remove: (record) => events.push(`remove:${record.name}`),
      };

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* ts.users.subscribe(subscriber);
            yield* ts.users.put(ALICE);
            yield* ts.users.put({ ...ALICE, level: 9 });
            yield* ts.users.delete("alice");
          }),
        ),
      );

      expect(events).toStrictEqual(["add:alice", "update:alice->alice", "remove:alice"]);

      // Scope closed: further mutations must not notify the (now-released) subscriber.
      await Effect.runPromise(ts.users.put(BOB));
      expect(events).toStrictEqual(["add:alice", "update:alice->alice", "remove:alice"]);
    });
  });

  it("releases the subscription even when the fiber is interrupted mid-scope, not just on clean completion", async () => {
    // This is the shape of the Phase 0 exit criterion's "abrupt disconnect" case (plan section
    // "Verification" — a live-subscription round trip must release its resources on interruption,
    // not only on a clean unmount/unsubscribe). Exercised here at the storage layer: this package
    // doesn't have a network boundary of its own, but `Effect.acquireRelease`'s interruption
    // behavior is exactly what the Backend stage's Cap'n Web `RpcTarget` will rely on.
    await withStorage("collection-subscribe-interrupt", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: { users: collection<User>()({ primaryKey: "name" }) },
      });

      let notified = 0;
      const subscriber: Subscriber<User> = {
        add: () => { notified++; },
        update: () => { notified++; },
        remove: () => { notified++; },
      };

      const program = Effect.scoped(
        Effect.gen(function* () {
          yield* ts.users.subscribe(subscriber);
          yield* Effect.never; // Simulates a live subscription held open indefinitely.
        }),
      );

      const fiber = Effect.runFork(program);
      // Give the fiber a tick to actually register the subscription before interrupting it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // `Fiber.interrupt` waits for interruption to finish running finalizers, so by the time
      // this resolves, `acquireRelease`'s release (the unsubscribe) has already run.
      await Effect.runPromise(Fiber.interrupt(fiber));

      // Subscriber must have been released by the interruption — a put() now must not notify it.
      await Effect.runPromise(ts.users.put(ALICE));
      expect(notified).toStrictEqual(0);
    });
  });
});

describe("createEffectTypedStorage: transaction()", () => {
  it("runs the callback inside storage.transactionSync() and returns its result as an Effect", async () => {
    await withStorage("transaction-basic", async (storage) => {
      const ts = createEffectTypedStorage(storage, {
        collections: { users: collection<User>()({ primaryKey: "name" }) },
      });

      const result = await Effect.runPromise(
        ts.transaction(() => {
          storage.kv.put("users:zzz-manual", { ...ALICE, name: "zzz-manual" });
          return "done";
        }),
      );
      expect(result).toStrictEqual("done");
      expect(await Effect.runPromise(ts.users.get("zzz-manual"))).toStrictEqual({ ...ALICE, name: "zzz-manual" });
    });
  });
});
