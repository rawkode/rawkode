// `ModelClientScripted` — the deterministic test double half of the plan's "two real Layer
// implementations" (plan §"Agent-native editing & gatekeeper integrations", "1. Pluggable
// model-client design"). Stands in for what a real LLM would produce: a caller pre-programs a
// fixed sequence of `ModelTurnResult`s (a "script"), and each `converse` call consumes the next
// one in order — the same FIFO-queue shape a hand-rolled fake would use, formalized as a real
// `Layer` so tests exercise the exact `ModelClient` Context.Tag boundary `AgentEditService`
// (Phase 3's next stage) will depend on, not a bypass of it.
//
// Design note (docs/agent-model-client.md has the full writeup): this is intentionally *not* a
// module-level mutable queue — `makeModelClientScripted` is a factory a test calls once per
// test case, closing over a fresh, test-owned array. That mirrors this codebase's own
// established caution about module-level mutable state (see `sync-feed-service-live.ts`'s
// `currentEpochAndGeneration` doc comment) and, more directly, means two tests running
// concurrently never share or race on the same script.

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { type ChatThread, ModelClient, ModelUnavailable, type ModelTurnResult, type ToolSpec } from "@athenaeum/domain"

/** One recorded `converse` invocation — exposed so a test can assert not just *what* the
 *  scripted client returned, but *what it was called with* (e.g. "the second call's thread
 *  included the tool_result from the first call's tool_use", proving the caller round-tripped
 *  history correctly). */
export interface ScriptedConverseCall {
  readonly thread: ChatThread
  readonly availableTools: ReadonlyArray<ToolSpec>
}

export interface ModelClientScriptedHandle {
  /** The `Layer` to `Effect.provide` in place of a real `ModelClientAnthropic` — same
   *  `ModelClient` Context.Tag, so code under test cannot tell the difference. */
  readonly layer: Layer.Layer<ModelClient>
  /** Every `converse` call made against this handle's layer, in order — mutated in place, so a
   *  test can read it after running its program rather than needing a return-value plumbing
   *  scheme. */
  readonly calls: Array<ScriptedConverseCall>
  /** Turns remaining in the script — lets a test assert the whole script was consumed (or
   *  deliberately wasn't), without needing to know the original script length. */
  readonly remaining: () => number
}

/**
 * Builds a fresh `ModelClientScripted` handle from a fixed, ordered sequence of turns. Each
 * `converse` call shifts the next turn off the front and returns it; calling `converse` more
 * times than the script has entries fails with `ModelUnavailable` (a script exhausted mid-test
 * is a test-configuration bug, not a "model is down" scenario a caller should retry — but it is
 * still, correctly, "this client cannot answer right now," which is exactly what
 * `ModelUnavailable` means per its own doc comment in `model-client.ts`).
 */
export const makeModelClientScripted = (
  script: ReadonlyArray<ModelTurnResult>
): ModelClientScriptedHandle => {
  const queue: Array<ModelTurnResult> = [...script]
  const calls: Array<ScriptedConverseCall> = []

  const layer = Layer.succeed(ModelClient, {
    converse: (thread, availableTools) =>
      Effect.sync(() => {
        calls.push({ thread, availableTools })
        return queue.shift()
      }).pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.fail(
                new ModelUnavailable({
                  message:
                    `ModelClientScripted: script exhausted after ${calls.length} converse() call(s) — ` +
                    "pre-program more turns via makeModelClientScripted(script) if the test needs another."
                })
              )
            : Effect.succeed(next)
        )
      )
  })

  return { layer, calls, remaining: () => queue.length }
}
