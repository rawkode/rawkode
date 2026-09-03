import { useEffect, useRef, useSyncExternalStore } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { EffectStore, type EffectState } from "./effect-store.js"
import { runtime } from "./runtime.js"
import type { WorkspaceRpcClient } from "./rpc-client.js"

// Plan quote (§"Web frontend data layer"): "a small custom useEffectQuery/useEffectSubscription
// hook pair on top of runtime.runFork + React's useSyncExternalStore, cancelling the fiber on
// unmount via Fiber.interrupt." This is the one-shot half of that pair — runs `effect` once per
// `deps` change via the app's single module-level `runtime` (see `runtime.ts`), publishing
// Loading/Success/Failure into an `EffectStore` that `useSyncExternalStore` subscribes to.
//
// Deliberately not `@effect/experimental`'s React integration — the plan calls that out as
// unstable and a poor fit for a long-horizon app.

/**
 * Runs `effect` via `runtime.runFork` once per `deps` change, returning its current
 * loading/success/failure state. On unmount (or before the next run) the in-flight fiber is
 * interrupted with `Fiber.interrupt` — not merely abandoned — so any resources it acquired
 * (e.g. an `Effect.acquireRelease`d Cap'n Web stub) are actually released.
 */
export function useEffectQuery<A, E>(
  effect: Effect.Effect<A, E, WorkspaceRpcClient>,
  deps: ReadonlyArray<unknown>
): EffectState<A, E> {
  const storeRef = useRef<EffectStore<A, E> | undefined>(undefined)
  if (!storeRef.current) storeRef.current = new EffectStore()
  const store = storeRef.current

  useEffect(() => {
    store.setState({ status: "loading" })

    // `Effect.exit` turns `effect` into a never-failing program whose result is an `Exit<A, E>` —
    // so the *outer* fiber (the one this hook interrupts on cleanup) only ever fails by
    // interruption, letting the observer below tell "the query actually failed" apart from
    // "we cancelled it because the component unmounted / deps changed".
    const fiber = runtime.runFork(Effect.exit(effect))

    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return // outer fiber was interrupted by our own cleanup below
      const inner = outer.value
      if (Exit.isSuccess(inner)) {
        store.setState({ status: "success", value: inner.value })
      } else if (!Exit.isInterrupted(inner)) {
        store.setState({ status: "failure", error: Cause.squash(inner.cause) as E })
      }
    })

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // `deps` is an intentionally opaque dependency list controlled by the caller, matching
    // `useEffect`'s own escape hatch for this exact pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
