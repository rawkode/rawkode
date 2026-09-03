import { useEffect, useRef, useSyncExternalStore } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import { EffectStore, type EffectState } from "./effect-store.js"
import { runtime } from "./runtime.js"
import type { WorkspaceRpcClient } from "./rpc-client.js"

// The live half of the plan's hook pair (see `use-effect-query.ts` for the one-shot half and the
// shared design rationale). `makeSubscription` is expected to `Effect.acquireRelease` a live
// handle (e.g. `WorkspaceRpcClient#subscribeToNodes`, which itself disposes a Cap'n Web
// `NodesSubscriptionApi` stub — and, on the server, the `NodesSubscription` `RpcTarget` it points
// at — when its `Scope` closes). This hook runs the whole thing inside `Effect.scoped`, so
// unmounting (which interrupts the fiber, which closes the scope) is what actually exercises the
// plan's live-subscription exit criterion: "confirm server-side Effect resources backing that
// subscription are actually released (not leaked)".

/**
 * Subscribes via `makeSubscription`, then loops calling its `next` effect forever, publishing
 * each emitted value as the current success state. `deps` controls when the subscription is
 * torn down and re-established (mirroring `useEffectQuery`); on unmount the fiber is interrupted,
 * which closes the `Scope` `makeSubscription` acquired its resources against.
 */
export function useEffectSubscription<A, E>(
  makeSubscription: Effect.Effect<{ readonly next: Effect.Effect<A, E> }, E, WorkspaceRpcClient | Scope.Scope>,
  deps: ReadonlyArray<unknown>
): EffectState<A, E> {
  const storeRef = useRef<EffectStore<A, E> | undefined>(undefined)
  if (!storeRef.current) storeRef.current = new EffectStore()
  const store = storeRef.current

  useEffect(() => {
    store.setState({ status: "loading" })

    const program = Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* makeSubscription
        yield* Effect.forever(
          subscription.next.pipe(
            Effect.tap((value) => Effect.sync(() => store.setState({ status: "success", value })))
          )
        )
      })
    )

    // Same `Effect.exit`-around-the-outer-fiber trick as `useEffectQuery`: `forever` only ever
    // stops by failing or being interrupted, and we need to tell "the subscription itself failed"
    // apart from "we interrupted it on cleanup" below.
    const fiber = runtime.runFork(Effect.exit(program))

    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return
      const inner = outer.value
      if (Exit.isFailure(inner) && !Exit.isInterrupted(inner)) {
        store.setState({ status: "failure", error: Cause.squash(inner.cause) as E })
      }
    })

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
