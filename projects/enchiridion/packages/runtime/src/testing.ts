import { Effect, Layer, TestClock, TestContext } from "effect";
import { type RuntimeConfig, layerRuntime } from "./config";
import { makeInMemoryTelemetry } from "./telemetry";

/** Standard deterministic test environment. Effect's TestContext supplies
 * TestClock/TestServices; tests can adjust time with TestClock.adjust. */
export const makeTestRuntime = (config: RuntimeConfig) =>
  Effect.gen(function* () {
    const telemetry = yield* makeInMemoryTelemetry;
    return {
      telemetry,
      layer: Layer.mergeAll(TestContext.TestContext, layerRuntime(config), telemetry.layer),
      adjustClock: TestClock.adjust,
    };
  });
