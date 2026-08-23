import * as Schema from "effect/Schema"
import { EntityId } from "@athenaeum/domain"

// Phase 0 has no auth or workspace-creation flow yet (plan §"Top risks" #6: auth is deferred,
// "open, not resolved" even by this plan). This is a deliberately minimal stand-in just so a
// real browser session has a stable `workspaceId` to exercise the createNode/listNodes/
// subscribeToNodes round trip against (plan's Phase 0 exit criteria) — not a design for how
// workspace identity will actually work once auth lands.

const STORAGE_KEY = "athenaeum:workspaceId"

const tryDecode = (candidate: string | null): EntityId | undefined => {
  if (candidate === null) return undefined
  try {
    return Schema.decodeUnknownSync(EntityId)(candidate)
  } catch {
    return undefined
  }
}

/**
 * Resolves which workspace this browser session talks to. `?workspace=<id>` in the URL wins (so two tabs
 * or two devices can be pointed at the same workspace by sharing a link — useful for manually
 * exercising the live-subscription exit criterion); otherwise a UUID is generated once and
 * persisted to `localStorage`, so reloading the same browser keeps talking to the same workspace
 * (and the same `WorkspaceDurableObject` instance) instead of minting a fresh one every reload.
 */
const resolveWorkspaceId = (): EntityId => {
  const url = new URL(window.location.href)
  const fromQuery = tryDecode(url.searchParams.get("workspace"))
  if (fromQuery !== undefined) return fromQuery

  const fromStorage = tryDecode(window.localStorage.getItem(STORAGE_KEY))
  if (fromStorage !== undefined) return fromStorage

  const generated = Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
  window.localStorage.setItem(STORAGE_KEY, generated)
  return generated
}

/** The active workspace id — see this file's header comment for the original (Phase 0, anonymous)
 *  resolution rule. Web-stage addition: a mutable binding (`let`, not `const`), so
 *  `WorkspaceSwitcher.tsx` can move the whole app to a different workspace after sign-in — see
 *  `runtime.ts`'s header comment for why a live ES-module binding plus an app-level React `key`
 *  remount, rather than prop-threading `workspaceId` through every component, is this stage's chosen
 *  mechanism (every existing component already does `import { workspaceId } from "./workspace-id.js"` at
 *  module scope, exactly like `runtime.ts`'s own `runtime` binding). */
export let workspaceId: EntityId = resolveWorkspaceId()

/** Sets the active workspace and persists it so a reload keeps talking to the same workspace (mirroring
 *  the original `?workspace=`/localStorage resolution rule above, now driven explicitly by the workspace
 *  switcher rather than only at first load). Does not itself reconnect anything — pair with
 *  `runtime.ts#switchWorkspaceConnection` and a remount, exactly as `App.tsx` does. */
export const setActiveWorkspaceId = (id: EntityId): void => {
  workspaceId = id
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // best-effort, same fail-open rationale as the rest of this file's localStorage use
  }
}
