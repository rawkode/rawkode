import { Context, Effect, Layer, Ref } from "effect";
import { type RuntimeErrorClassification, TelemetryInputRejectedError } from "./errors";

/** Closed events deliberately have no caller-provided names or string maps. */
export type RuntimeTelemetryEvent =
  | { readonly name: "operation.start" }
  | { readonly name: "operation.success" }
  | {
      readonly name: "operation.failure";
      readonly attributes: {
        readonly errorTag: RuntimeErrorClassification;
        readonly retryable?: boolean;
      };
    };

export interface RuntimeTelemetry {
  readonly record: (
    event: RuntimeTelemetryEvent,
  ) => Effect.Effect<void, TelemetryInputRejectedError>;
}

export const RuntimeTelemetry = Context.GenericTag<RuntimeTelemetry>(
  "@enchiridion/runtime/RuntimeTelemetry",
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);

const safeTags: ReadonlySet<string> = new Set([
  "RuntimeConfigError",
  "ExternalServiceError",
  "OperationTimeoutError",
  "AdapterContractError",
  "TelemetryInputRejectedError",
  "P256VerificationError",
  "ImmutableR2Error",
  "ManifestKeyRingConfigurationError",
  "ManifestSigningError",
  "ManifestVerificationError",
  "unclassified",
]);

const isRuntimeErrorClassification = (value: unknown): value is RuntimeErrorClassification =>
  typeof value === "string" && safeTags.has(value);

/** Rejects unknown fields rather than leaking a secret-bearing name or value. */
export const validateRuntimeTelemetryEvent = (
  event: unknown,
): Effect.Effect<RuntimeTelemetryEvent, TelemetryInputRejectedError> => {
  if (!isRecord(event) || typeof event.name !== "string") {
    return Effect.fail(new TelemetryInputRejectedError({ reason: "invalid_event" }));
  }
  if (
    (event.name === "operation.start" || event.name === "operation.success") &&
    exactKeys(event, ["name"])
  ) {
    return Effect.succeed({ name: event.name });
  }
  if (event.name !== "operation.failure" || !exactKeys(event, ["name", "attributes"])) {
    return Effect.fail(new TelemetryInputRejectedError({ reason: "invalid_event" }));
  }
  if (!isRecord(event.attributes) || !("errorTag" in event.attributes)) {
    return Effect.fail(new TelemetryInputRejectedError({ reason: "unsafe_attribute" }));
  }
  const { errorTag, retryable } = event.attributes;
  if (
    !isRuntimeErrorClassification(errorTag) ||
    (retryable !== undefined && typeof retryable !== "boolean") ||
    !exactKeys(event.attributes, retryable === undefined ? ["errorTag"] : ["errorTag", "retryable"])
  ) {
    return Effect.fail(new TelemetryInputRejectedError({ reason: "unsafe_attribute" }));
  }
  return Effect.succeed({
    name: "operation.failure",
    attributes: retryable === undefined ? { errorTag } : { errorTag, retryable },
  });
};

export const noopTelemetryLayer: Layer.Layer<RuntimeTelemetry> = Layer.succeed(RuntimeTelemetry, {
  record: () => Effect.void,
});

export const makeInMemoryTelemetry = Effect.gen(function* () {
  const events = yield* Ref.make<ReadonlyArray<RuntimeTelemetryEvent>>([]);
  return {
    events,
    layer: Layer.succeed(RuntimeTelemetry, {
      record: (event) =>
        Effect.flatMap(validateRuntimeTelemetryEvent(event), (safeEvent) =>
          Ref.update(events, (current) => [...current, safeEvent]),
        ),
    }),
  };
});
