import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";
import {
  DurableObjectBoundaryError,
  type DurableObjectStateNative,
  type DurableObjectStorageNative,
  type DurableObjectTransactionNative,
  adoptDurableObjectValue,
  makeDurableObjectBoundary,
} from "./index";

interface Identity {
  readonly ownerID: string;
}

const decodeIdentity = (value: unknown): Identity | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const ownerID = Object.entries(value).find(([key]) => key === "ownerID")?.[1];
  return typeof ownerID === "string" ? { ownerID } : undefined;
};

const equivalentIdentity = (left: Identity, right: Identity): boolean =>
  left.ownerID === right.ownerID;

const makeState = (
  options: { readonly rejectGet?: boolean } = {},
): {
  readonly state: DurableObjectStateNative;
  readonly entries: Map<string, unknown>;
  readonly transactionOperations: readonly boolean[];
} => {
  const entries = new Map<string, unknown>();
  const transactionOperations: boolean[] = [];
  let activeTransactions = 0;
  let transactionTail = Promise.resolve();
  let concurrencyTail = Promise.resolve();
  const transaction: DurableObjectTransactionNative = {
    get: (key) => {
      transactionOperations.push(activeTransactions === 1);
      return options.rejectGet
        ? Promise.reject(new Error("storage-secret"))
        : Promise.resolve(entries.get(key));
    },
    put: (key, value) => {
      transactionOperations.push(activeTransactions === 1);
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      transactionOperations.push(activeTransactions === 1);
      return Promise.resolve(entries.delete(key));
    },
  };
  const storage: DurableObjectStorageNative = {
    ...transaction,
    transaction: (callback) => {
      const next = transactionTail.then(() => {
        activeTransactions += 1;
        return Promise.resolve(callback(transaction)).then(
          (value) => {
            activeTransactions -= 1;
            return value;
          },
          (error: unknown) => {
            activeTransactions -= 1;
            throw error;
          },
        );
      });
      transactionTail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  return {
    state: {
      storage,
      blockConcurrencyWhile: (callback) => {
        const next = concurrencyTail.then(callback);
        concurrencyTail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
    entries,
    transactionOperations,
  };
};

describe("Durable Object runtime boundary", () => {
  test("maps rejected storage and callback defects to closed safe errors", async () => {
    const storageExit = await Effect.runPromiseExit(
      makeDurableObjectBoundary(makeState({ rejectGet: true }).state).storage.get("identity"),
    );
    expect(Exit.isFailure(storageExit)).toBe(true);
    expect(JSON.stringify(storageExit)).not.toContain("storage-secret");
    expect(JSON.stringify(storageExit)).toContain('"operation":"storage_get"');

    const boundary = makeDurableObjectBoundary(makeState().state);
    let callbackError: unknown;
    try {
      await boundary.callbacks.fetch(Effect.die("callback-secret"));
    } catch (error) {
      callbackError = error;
    }
    expect(String(callbackError)).toContain(DurableObjectBoundaryError.name);
    expect(JSON.stringify(callbackError)).not.toContain("callback-secret");
    expect(JSON.stringify(callbackError)).toContain('"reason":"callback_failed"');
  });

  test("serializes blockConcurrencyWhile Effects and uses atomic storage adoption", async () => {
    const native = makeState();
    const boundary = makeDurableObjectBoundary(native.state);
    const observedMaximum = await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* Ref.make(0);
        const maximum = yield* Ref.make(0);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = boundary.callbacks.blockConcurrencyWhile(
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (value) => value + 1);
            yield* Ref.update(maximum, (value) => Math.max(value, current));
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            yield* Ref.update(active, (value) => value - 1);
          }),
        );
        const second = boundary.callbacks.blockConcurrencyWhile(
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (value) => value + 1);
            yield* Ref.update(maximum, (value) => Math.max(value, current));
            yield* Ref.update(active, (value) => value - 1);
          }),
        );
        const callbacks = yield* Effect.all([first, second], { concurrency: "unbounded" }).pipe(
          Effect.fork,
        );
        yield* Deferred.await(entered);
        expect(yield* Ref.get(active)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(callbacks);
        return yield* Ref.get(maximum);
      }),
    );
    expect(observedMaximum).toBe(1);

    const [first, same, conflict] = await Effect.runPromise(
      Effect.all(
        [
          adoptDurableObjectValue(
            boundary.storage,
            "identity",
            { ownerID: "owner-1" },
            decodeIdentity,
            equivalentIdentity,
          ),
          adoptDurableObjectValue(
            boundary.storage,
            "identity",
            { ownerID: "owner-1" },
            decodeIdentity,
            equivalentIdentity,
          ),
          adoptDurableObjectValue(
            boundary.storage,
            "identity",
            { ownerID: "owner-2" },
            decodeIdentity,
            equivalentIdentity,
          ),
        ],
        { concurrency: "unbounded" },
      ),
    );
    expect([first, same, conflict]).toEqual([true, true, false]);
    expect(native.entries).toEqual(new Map([["identity", { ownerID: "owner-1" }]]));
    expect(native.transactionOperations.every(Boolean)).toBe(true);
  });
});
