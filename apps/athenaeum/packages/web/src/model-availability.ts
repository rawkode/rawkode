// Interaction pass (design-review 2026-08-22 finding #18 / flows F4.1 — "the no-model error reply
// is ephemeral; unanswered messages accumulate silently"): the "no AI model configured" state used
// to live only in `ActiveChatView`'s transient per-send React state, so any navigation/remount/
// reload dropped the explanation while the unanswered messages stayed. It's now a tiny external
// store (module listeners + `useSyncExternalStore`, the same shape `effect-store.ts` establishes)
// persisted to `localStorage` (the same client-side persistence `sync-feed-client.ts` /
// `mentions-relation.ts` already use), so the chat rail can render a standing banner derived from
// state rather than from one reply.
//
// Why not a backend "is a model configured" RPC: there deliberately isn't one — `model-client.ts`'s
// own doc comment records that `ModelClient` is consumed server-side only and that surfacing its
// availability speculatively was considered and rejected. The only real signal at this boundary is
// a `sendChatMessage` outcome, so that's what feeds the store: a `ModelUnavailable` failure sets
// the flag, the next successful send clears it. Storage failures (private mode, disabled storage)
// degrade to the old in-memory behavior — the flag still works for the session via the module
// variable; it just doesn't survive a reload.

const STORAGE_KEY = "athenaeum:model-unavailable"

const readStored = (): boolean => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

let modelUnavailable = readStored()
const listeners = new Set<() => void>()

export const isModelUnavailable = (): boolean => modelUnavailable

export const setModelUnavailable = (value: boolean): void => {
  if (modelUnavailable === value) return
  modelUnavailable = value
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, "true")
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Best-effort persistence only — the in-memory flag above is the session's source of truth.
  }
  for (const listener of listeners) listener()
}

export const subscribeModelAvailability = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
