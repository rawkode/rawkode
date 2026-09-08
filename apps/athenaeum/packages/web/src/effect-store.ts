// A tiny external store `useEffectQuery`/`useEffectSubscription` publish to and React subscribes
// to via `useSyncExternalStore` (plan §"Web frontend data layer": "a small custom
// useEffectQuery/useEffectSubscription hook pair on top of runtime.runFork + React's
// useSyncExternalStore"). Deliberately not a general-purpose state-management library — one
// instance per hook call, created once via `useRef` and mutated in place across the hook's
// lifetime, discarded with the component.

export type EffectState<A, E> =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly value: A }
  | { readonly status: "failure"; readonly error: E }

export class EffectStore<A, E> {
  #state: EffectState<A, E>
  readonly #listeners = new Set<() => void>()

  constructor(initial: EffectState<A, E> = { status: "loading" }) {
    this.#state = initial
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): EffectState<A, E> => this.#state

  readonly setState = (next: EffectState<A, E>): void => {
    this.#state = next
    for (const listener of this.#listeners) listener()
  }
}
