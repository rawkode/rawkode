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
  options: { readonly rejectGet?: boolean; readonly rejectAlarm?: boolean } = {},
): {
  readonly state: DurableObjectStateNative;
  readonly entries: Map<string, unknown>;
  readonly transactionOperations: readonly boolean[];
  readonly alarm: () => number | null;
} => {
  const entries = new Map<string, unknown>();
  const transactionOperations: boolean[] = [];
  let activeTransactions = 0;
  let transactionTail = Promise.resolve();
  let concurrencyTail = Promise.resolve();
  let scheduledAlarm: number | null = null;
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
    getAlarm: () =>
      options.rejectAlarm
        ? Promise.reject(new Error("alarm-secret"))
        : Promise.resolve(scheduledAlarm),
    setAlarm: (epochMilliseconds) =>
      options.rejectAlarm
        ? Promise.reject(new Error("alarm-secret"))
        : Promise.resolve().then(() => {
            scheduledAlarm = epochMilliseconds;
          }),
    deleteAlarm: () =>
      options.rejectAlarm
        ? Promise.reject(new Error("alarm-secret"))
        : Promise.resolve().then(() => {
            scheduledAlarm = null;
          }),
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
    alarm: () => scheduledAlarm,
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

    const alarmExit = await Effect.runPromiseExit(
      makeDurableObjectBoundary(makeState({ rejectAlarm: true }).state).storage.getAlarm(),
    );
    expect(Exit.isFailure(alarmExit)).toBe(true);
    expect(JSON.stringify(alarmExit)).not.toContain("alarm-secret");
    expect(JSON.stringify(alarmExit)).toContain('"operation":"storage_get_alarm"');

    const setAlarmExit = await Effect.runPromiseExit(
      makeDurableObjectBoundary(makeState({ rejectAlarm: true }).state).storage.setAlarm(
        1_760_000_000_000,
      ),
    );
    expect(Exit.isFailure(setAlarmExit)).toBe(true);
    expect(JSON.stringify(setAlarmExit)).not.toContain("alarm-secret");
    expect(JSON.stringify(setAlarmExit)).toContain('"operation":"storage_set_alarm"');

    const deleteAlarmExit = await Effect.runPromiseExit(
      makeDurableObjectBoundary(makeState({ rejectAlarm: true }).state).storage.deleteAlarm(),
    );
    expect(Exit.isFailure(deleteAlarmExit)).toBe(true);
    expect(JSON.stringify(deleteAlarmExit)).not.toContain("alarm-secret");
    expect(JSON.stringify(deleteAlarmExit)).toContain('"operation":"storage_delete_alarm"');

    let alarmCallbackError: unknown;
    try {
      await boundary.callbacks.alarm(Effect.die("alarm-callback-secret"));
    } catch (error) {
      alarmCallbackError = error;
    }
    expect(String(alarmCallbackError)).toContain(DurableObjectBoundaryError.name);
    expect(JSON.stringify(alarmCallbackError)).not.toContain("alarm-callback-secret");
    expect(JSON.stringify(alarmCallbackError)).toContain('"operation":"alarm_callback"');
  });

  test("adapts Cloudflare alarm storage structurally", async () => {
    const native = makeState();
    const boundary = makeDurableObjectBoundary(native.state);
    expect(await Effect.runPromise(boundary.storage.getAlarm())).toBeNull();
    await Effect.runPromise(boundary.storage.setAlarm(1_760_000_000_000));
    expect(native.alarm()).toBe(1_760_000_000_000);
    expect(await Effect.runPromise(boundary.storage.getAlarm())).toBe(1_760_000_000_000);
    await Effect.runPromise(boundary.storage.deleteAlarm());
    expect(native.alarm()).toBeNull();
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
