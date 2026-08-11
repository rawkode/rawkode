import { Effect, Schedule } from "effect";
import type { OperationPolicy } from "./config";
import {
  ExternalServiceError,
  OperationTimeoutError,
  type RuntimeOperationIdentifier,
  classifyRuntimeError,
  isRetryableExternalServiceError,
} from "./errors";
import { OperationLimiter } from "./limiter";
import { RuntimeTelemetry } from "./telemetry";

/** Applies the single approved operational policy: bounded concurrency,
 * exponential retry, timeout, and start/success/failure telemetry. */
export const withOperationPolicy = <A, E>(
  operation: RuntimeOperationIdentifier,
  policy: OperationPolicy,
  effect: Effect.Effect<A, E, RuntimeTelemetry | OperationLimiter>,
): Effect.Effect<
  A,
  E | OperationTimeoutError | import("./errors").TelemetryInputRejectedError,
  RuntimeTelemetry | OperationLimiter
> => {
  const retry = Schedule.compose(
    Schedule.exponential(`${policy.retry.baseDelayMs} millis`),
    Schedule.recurs(policy.retry.maxRetries),
  );
  return Effect.gen(function* () {
    const telemetry = yield* RuntimeTelemetry;
    const limiter = yield* OperationLimiter;
    yield* telemetry.record({ name: "operation.start" });
    const result = yield* effect.pipe(
      Effect.retry({ schedule: retry, while: isRetryableExternalServiceError }),
      Effect.timeoutFail({
        duration: `${policy.timeoutMs} millis`,
        onTimeout: () => new OperationTimeoutError({ operation, timeoutMs: policy.timeoutMs }),
      }),
      limiter.withPermit,
    );
    yield* telemetry.record({ name: "operation.success" });
    return result;
  }).pipe(
    Effect.tapError((error) =>
      Effect.flatMap(RuntimeTelemetry, (telemetry) =>
        telemetry.record({
          name: "operation.failure",
          attributes: {
            errorTag: classifyRuntimeError(error),
            ...(error instanceof ExternalServiceError ? { retryable: error.retryable } : {}),
          },
        }),
      ),
    ),
  );
};
