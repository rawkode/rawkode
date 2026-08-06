import { describe, expect, test } from "bun:test";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
} from "effect";
import {
  AdapterContractError,
  ExternalServiceError,
  OperationTimeoutError,
  RuntimeConfigError,
  RuntimeOperation,
  type RuntimeOperationConfig,
  cloudflareAdapterLedger,
  defaultOperationPolicy,
  fromCloudflarePromise,
  layerRuntime,
  makeInMemoryTelemetry,
  makeRuntimeConfig,
  makeTestRuntime,
  runtimeConfigSource,
  unknownRecord,
  validateRuntimeTelemetryEvent,
  withOperationPolicy,
} from "./index";

type RuntimeOperationInput = Omit<Partial<RuntimeOperationConfig>, "retry"> & {
  readonly retry?: Partial<RuntimeOperationConfig["retry"]>;
};

const validConfig = (operation?: RuntimeOperationInput) => {
  const config = makeRuntimeConfig({ environment: "test", operation });
  if (config instanceof RuntimeConfigError) throw new Error("expected valid config");
  return config;
};

describe("runtime", () => {
  test("loads Effect Config and retains observability material as Redacted", async () => {
    const config = await Effect.runPromise(
      runtimeConfigSource.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["ENCHIRIDION_RUNTIME_ENVIRONMENT", "test"],
              ["ENCHIRIDION_RUNTIME_OBSERVABILITY_SECRET", "not-for-logs"],
            ]),
          ),
        ),
      ),
    );
    expect(config.environment).toBe("test");
    expect(Option.isSome(config.observabilitySecret)).toBe(true);
    if (Option.isNone(config.observabilitySecret)) throw new Error("expected observability secret");
    expect(String(config.observabilitySecret.value)).not.toContain("not-for-logs");
    expect(Redacted.value(config.observabilitySecret.value)).toBe("not-for-logs");
    expect(validConfig().observabilitySecret).toEqual(Option.none());
    expect(
      makeRuntimeConfig({ environment: "test", operation: { concurrency: 0 } }),
    ).toBeInstanceOf(RuntimeConfigError);
  });

  test("default promise rejections are nonretryable and discard secret causes", async () => {
    const telemetry = await Effect.runPromise(makeInMemoryTelemetry);
    let authAttempts = 0;
    let nonIdempotentAttempts = 0;
    const layer = Layer.merge(layerRuntime(validConfig({ concurrency: 1 })), telemetry.layer);
    const runRejected = (increment: () => void) =>
      withOperationPolicy(
        RuntimeOperation.CloudflareBinding,
        { timeoutMs: 100, retry: { maxRetries: 2, baseDelayMs: 0 } },
        Effect.suspend(() => {
          increment();
          return fromCloudflarePromise(RuntimeOperation.CloudflareBinding, () =>
            Promise.reject(new Error("Bearer secret-token")),
          );
        }),
      ).pipe(Effect.provide(layer));

    const authExit = await Effect.runPromiseExit(
      runRejected(() => {
        authAttempts += 1;
      }),
    );
    const writeExit = await Effect.runPromiseExit(
      runRejected(() => {
        nonIdempotentAttempts += 1;
      }),
    );
    expect(authAttempts).toBe(1);
    expect(nonIdempotentAttempts).toBe(1);
    expect(JSON.stringify(authExit)).not.toContain("secret-token");
    expect(JSON.stringify(writeExit)).toContain('"retryable":false');
  });

  test("rejects non-record unknown adapter input", async () => {
    const exit = await Effect.runPromiseExit(unknownRecord("unknown-record", []));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("expected failure");
    expect(String(exit.cause)).toContain(AdapterContractError.name);
  });

  test("records only closed telemetry events through the operation policy", async () => {
    const telemetry = await Effect.runPromise(makeInMemoryTelemetry);
    const layer = Layer.merge(layerRuntime(validConfig({ concurrency: 1 })), telemetry.layer);
    const result = await Effect.runPromise(
      withOperationPolicy(
        RuntimeOperation.SharedEffect,
        defaultOperationPolicy,
        Effect.succeed("ok"),
      ).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("ok");
    expect(await Effect.runPromise(Ref.get(telemetry.events))).toEqual([
      { name: "operation.start" },
      { name: "operation.success" },
    ]);
    expect(cloudflareAdapterLedger).toHaveLength(9);
    expect(cloudflareAdapterLedger.some(({ id }) => id === "access-jose-jwks")).toBe(true);
    expect(cloudflareAdapterLedger.map((entry) => entry.id)).toEqual([
      "cloudflare-promise",
      "unknown-record",
      "capability-hmac",
      "p256-webcrypto",
      "immutable-r2",
      "manifest-p256-webcrypto",
      "worker-outer-boundary",
      "access-jose-jwks",
      "durable-object-callback-storage",
    ]);
  });

  test("turns a slow operation into a tagged timeout with TestClock", async () => {
    const runtime = await Effect.runPromise(makeTestRuntime(validConfig()));
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* withOperationPolicy(
          RuntimeOperation.SharedEffect,
          { timeoutMs: 1, retry: { maxRetries: 0, baseDelayMs: 0 } },
          Effect.never,
        ).pipe(Effect.fork);
        yield* runtime.adjustClock("1 millis");
        return yield* Effect.exit(Fiber.join(fiber));
      }).pipe(Effect.provide(runtime.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("expected timeout");
    expect(String(exit.cause)).toContain(OperationTimeoutError.name);
  });

  test("shares one limiter across concurrent wrapped calls", async () => {
    const telemetry = await Effect.runPromise(makeInMemoryTelemetry);
    const layer = Layer.merge(layerRuntime(validConfig({ concurrency: 1 })), telemetry.layer);
    const maximum = await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* Ref.make(0);
        const observedMaximum = yield* Ref.make(0);
        const firstEntered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const work = Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(active, (value) => value + 1);
          yield* Ref.update(observedMaximum, (value) => Math.max(value, current));
          yield* Deferred.succeed(firstEntered, undefined);
          yield* Deferred.await(release);
          yield* Ref.update(active, (value) => value - 1);
        });
        const wrapped = withOperationPolicy(
          RuntimeOperation.SharedEffect,
          { timeoutMs: 100, retry: { maxRetries: 0, baseDelayMs: 0 } },
          work,
        );
        const fiber = yield* Effect.all([wrapped, wrapped, wrapped], {
          concurrency: "unbounded",
        }).pipe(Effect.fork);
        yield* Deferred.await(firstEntered);
        expect(yield* Ref.get(active)).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        return yield* Ref.get(observedMaximum);
      }).pipe(Effect.provide(layer)),
    );
    expect(maximum).toBe(1);
  });

  test("does not retry permanent errors or expose their messages in telemetry", async () => {
    const telemetry = await Effect.runPromise(makeInMemoryTelemetry);
    let attempts = 0;
    const effect = withOperationPolicy(
      RuntimeOperation.SharedEffect,
      { timeoutMs: 100, retry: { maxRetries: 2, baseDelayMs: 0 } },
      Effect.suspend(() => {
        attempts += 1;
        return Effect.fail(
          new ExternalServiceError({ operation: RuntimeOperation.SharedEffect, retryable: false }),
        );
      }),
    ).pipe(Effect.provide(Layer.merge(layerRuntime(validConfig()), telemetry.layer)));
    await Effect.runPromiseExit(effect);
    expect(attempts).toBe(1);
    expect(await Effect.runPromise(Ref.get(telemetry.events))).toEqual([
      { name: "operation.start" },
      {
        name: "operation.failure",
        attributes: { errorTag: "ExternalServiceError", retryable: false },
      },
    ]);
  });

  test("rejects secret-bearing telemetry input without serializing it", async () => {
    const exit = await Effect.runPromiseExit(
      validateRuntimeTelemetryEvent({
        name: "operation.start",
        authorization: "Bearer secret-token",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("secret-token");
  });

  test("reconstructs public tagged errors without retaining extra input fields", () => {
    const intermediate = {
      operation: RuntimeOperation.SharedEffect,
      retryable: false,
      secret: "Bearer secret-token",
    };
    const error = new ExternalServiceError(intermediate);
    expect(JSON.stringify(error)).not.toContain("secret-token");
    expect(Object.keys(error).sort()).toEqual(["_tag", "operation", "retryable"]);
  });
});
