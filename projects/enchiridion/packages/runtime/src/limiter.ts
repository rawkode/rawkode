import { Context, Effect, Layer } from "effect";

/** A worker-runtime singleton: every `withOperationPolicy` call shares it. */
export interface OperationLimiter {
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const OperationLimiter = Context.GenericTag<OperationLimiter>(
  "@enchiridion/runtime/OperationLimiter",
);

export const layerOperationLimiter = (concurrency: number): Layer.Layer<OperationLimiter> =>
  Layer.effect(
    OperationLimiter,
    Effect.map(Effect.makeSemaphore(concurrency), (semaphore) => ({
      withPermit: (effect) => semaphore.withPermits(1)(effect),
    })),
  );
