import { Config, Context, Effect, Layer, Option, type Redacted } from "effect";
import { RuntimeConfigError } from "./errors";
import { layerOperationLimiter } from "./limiter";

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
}

export interface OperationPolicy {
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
}

/** Runtime construction settings. Concurrency is applied once by `layerRuntime`,
 * not accepted by each `withOperationPolicy` call. */
export interface RuntimeOperationConfig extends OperationPolicy {
  readonly concurrency: number;
}

/** Runtime-wide configuration. The optional secret is observability-only: it
 * is loaded by Effect Config as Redacted and never models an Access/API token. */
export interface RuntimeConfig {
  readonly environment: "development" | "test" | "production";
  readonly observabilitySecret: Option.Option<Redacted.Redacted>;
  readonly operation: RuntimeOperationConfig;
}

export const RuntimeConfig = Context.GenericTag<RuntimeConfig>(
  "@enchiridion/runtime/RuntimeConfig",
);

export const defaultOperationPolicy: OperationPolicy = {
  timeoutMs: 15_000,
  retry: { maxRetries: 2, baseDelayMs: 100 },
};

export const defaultRuntimeOperationConfig: RuntimeOperationConfig = {
  ...defaultOperationPolicy,
  concurrency: 8,
};

const positiveInteger = (name: string, fallback: number) =>
  Config.integer(name).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${name} must be a positive integer`,
      validation: (value) => value > 0,
    }),
  );

const nonNegativeInteger = (name: string, fallback: number) =>
  Config.integer(name).pipe(
    Config.withDefault(fallback),
    Config.validate({
      message: `${name} must be a non-negative integer`,
      validation: (value) => value >= 0,
    }),
  );

/** The production Effect Config source. It is injectable through ConfigProvider in tests. */
export const runtimeConfigSource = Config.all({
  environment: Config.literal(
    "development",
    "test",
    "production",
  )("ENCHIRIDION_RUNTIME_ENVIRONMENT").pipe(Config.withDefault("development")),
  observabilitySecret: Config.option(Config.redacted("ENCHIRIDION_RUNTIME_OBSERVABILITY_SECRET")),
  operation: Config.all({
    timeoutMs: positiveInteger("ENCHIRIDION_RUNTIME_TIMEOUT_MS", defaultOperationPolicy.timeoutMs),
    concurrency: positiveInteger(
      "ENCHIRIDION_RUNTIME_CONCURRENCY",
      defaultRuntimeOperationConfig.concurrency,
    ),
    retry: Config.all({
      maxRetries: nonNegativeInteger(
        "ENCHIRIDION_RUNTIME_MAX_RETRIES",
        defaultOperationPolicy.retry.maxRetries,
      ),
      baseDelayMs: nonNegativeInteger(
        "ENCHIRIDION_RUNTIME_RETRY_BASE_DELAY_MS",
        defaultOperationPolicy.retry.baseDelayMs,
      ),
    }),
  }),
});

export type RuntimeOperationConfigInput = Omit<Partial<RuntimeOperationConfig>, "retry"> & {
  readonly retry?: Partial<RetryPolicy>;
};

export const makeRuntimeConfig = (input: {
  readonly environment: RuntimeConfig["environment"];
  readonly observabilitySecret?: Redacted.Redacted;
  readonly operation?: RuntimeOperationConfigInput;
}): RuntimeConfig | RuntimeConfigError => {
  const operation: RuntimeOperationConfig = {
    timeoutMs: input.operation?.timeoutMs ?? defaultOperationPolicy.timeoutMs,
    concurrency: input.operation?.concurrency ?? defaultRuntimeOperationConfig.concurrency,
    retry: {
      maxRetries: input.operation?.retry?.maxRetries ?? defaultOperationPolicy.retry.maxRetries,
      baseDelayMs: input.operation?.retry?.baseDelayMs ?? defaultOperationPolicy.retry.baseDelayMs,
    },
  };
  if (!Number.isInteger(operation.concurrency) || operation.concurrency < 1) {
    return new RuntimeConfigError({
      field: "operation.concurrency",
      reason: "must_be_positive",
    });
  }
  if (!Number.isFinite(operation.timeoutMs) || operation.timeoutMs <= 0) {
    return new RuntimeConfigError({ field: "operation.timeoutMs", reason: "must_be_positive" });
  }
  if (!Number.isInteger(operation.retry.maxRetries) || operation.retry.maxRetries < 0) {
    return new RuntimeConfigError({
      field: "operation.retry.maxRetries",
      reason: "must_be_non_negative",
    });
  }
  if (!Number.isFinite(operation.retry.baseDelayMs) || operation.retry.baseDelayMs < 0) {
    return new RuntimeConfigError({
      field: "operation.retry.baseDelayMs",
      reason: "must_be_non_negative",
    });
  }
  return {
    environment: input.environment,
    observabilitySecret: Option.fromNullable(input.observabilitySecret),
    operation,
  };
};

export const layerRuntimeConfig = (config: RuntimeConfig): Layer.Layer<RuntimeConfig> =>
  Layer.succeed(RuntimeConfig, config);

/** Shared services built once per worker runtime; all wrapped calls share its limiter. */
export const layerRuntime = (config: RuntimeConfig) =>
  Layer.merge(layerRuntimeConfig(config), layerOperationLimiter(config.operation.concurrency));

export const layerRuntimeFromEffectConfig = Layer.unwrapEffect(
  Effect.map(runtimeConfigSource, (config) => layerRuntime(config)),
);
