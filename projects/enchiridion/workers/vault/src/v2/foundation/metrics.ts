/** @enchiridion/effect-module */
import { Context, Effect, Layer, Ref } from "effect";

export type VaultMetricName =
  | "access.accepted"
  | "access.rejected"
  | "access.jwks_refresh"
  | "directory.initialized"
  | "directory.retry";

export interface VaultV2Metrics {
  readonly increment: (name: VaultMetricName) => Effect.Effect<void>;
}

export const VaultV2Metrics = Context.GenericTag<VaultV2Metrics>(
  "@enchiridion/worker-vault/v2/VaultV2Metrics",
);

export const noopVaultV2MetricsLayer: Layer.Layer<VaultV2Metrics> = Layer.succeed(VaultV2Metrics, {
  increment: () => Effect.void,
});

export const makeInMemoryVaultV2Metrics = Effect.gen(function* () {
  const values = yield* Ref.make<Readonly<Record<VaultMetricName, number>>>({
    "access.accepted": 0,
    "access.rejected": 0,
    "access.jwks_refresh": 0,
    "directory.initialized": 0,
    "directory.retry": 0,
  });
  return {
    values,
    layer: Layer.succeed(VaultV2Metrics, {
      increment: (name) =>
        Ref.update(values, (current) => ({ ...current, [name]: current[name] + 1 })),
    }),
  };
});
