import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import * as ManagedRuntime from "effect/ManagedRuntime"
import type { EntityId } from "@athenaeum/domain"
import { makeWorkspaceRpcClientLive, type WorkspaceRpcClient } from "./rpc-client.js"
import { backendWsBase } from "./backend-host.js"
import { workspaceId } from "./workspace-id.js"

// Plan quote (§"Web frontend data layer"): "build a ManagedRuntime once at app boot from the
// composed frontend Layer (do not rebuild the Layer per call/render — this is the standard
// mistake to avoid)". This module is evaluated exactly once, at import time (ES module
// semantics), and the guidance above still holds *within one connection's lifetime* — but the web
// stage's sign-in/workspace-switcher work adds a real requirement the original Phase 0 comment didn't
// anticipate: the WebSocket URL a `WorkspaceRpcClient` connects to is no longer a load-time constant
// (it now depends on which workspace is active and which user's Bearer credential is presented), so
// *some* rebuild-on-change is unavoidable once auth/multi-workspace exist.
//
// The chosen shape: `runtime` stays a single well-known *binding* (an `export let`, not `const`)
// that every consumer (`use-effect-query.ts`, `use-effect-subscription.ts`, every component that
// does `import { runtime } from "./runtime.js"`) reads fresh at call time — ES module live
// bindings mean a reassignment inside this module is visible to every importer without them
// needing to re-import anything. `switchWorkspaceConnection` is the one place that reassignment
// happens: it builds a brand-new `ManagedRuntime` (a brand-new WebSocket connection) for the
// requested workspace/credential, swaps the binding, and disposes the previous runtime's scope
// (closing its socket) in the background. This does NOT retroactively reconnect any
// already-running subscription fiber or in-flight query — those keep talking to the OLD runtime
// object they captured when they started. `App.tsx` accounts for this by giving the workspace
// component tree a React `key` derived from `${workspaceId}:${credential}`, forcing every child to
// unmount (interrupting their fibers, releasing their scopes — the hooks' own documented cleanup
// path) and remount fresh against the just-swapped `runtime` binding whenever the active
// connection changes. This is a deliberate app-level convention, not a workaround: "rebuild the
// Layer per call/render" is still avoided (a render doesn't rebuild anything; only an explicit
// sign-in/workspace-switch action does), and every *individual* runtime instance is still built once
// and reused for its whole connection lifetime, exactly as the plan describes.

const buildRuntime = (
  forWorkspaceId: EntityId,
  credential?: string
): ManagedRuntime.ManagedRuntime<WorkspaceRpcClient, never> => {
  const tokenSuffix = credential !== undefined ? `?token=${encodeURIComponent(credential)}` : ""
  const wsUrl = `${backendWsBase}/api/workspace/${forWorkspaceId}${tokenSuffix}`
  const AppLayer = Layer.mergeAll(makeWorkspaceRpcClientLive(wsUrl), Logger.minimumLogLevel(LogLevel.Info))
  return ManagedRuntime.make(AppLayer)
}

/** The live `WorkspaceRpcClient` runtime — see this file's header comment for why this is a mutable
 *  binding rather than a `const`. Starts anonymous (no Bearer credential) against whatever
 *  `workspace-id.ts` resolves at import time, preserving the exact Phase 0-3 anonymous-connection
 *  behavior for any code path reached before sign-in completes. */
export let runtime = buildRuntime(workspaceId)

/**
 * Opaque identity for the current live runtime connection.  A runtime object is the primary
 * identity used by long-lived in-process work, but exposing this separate token makes a scope
 * replacement explicit to UI code that may otherwise still hold a live ES-module binding from
 * the prior connection for one render tick.
 *
 * This is deliberately process-local: it protects attachment/adoption boundaries during an
 * auth or workspace switch; it does not claim any reload, crash, or tab-close durability.
 */
export let runtimeConnectionIdentity: object = Object.freeze({})

/**
 * Swaps the live connection to `nextWorkspaceId`, presenting `credential` (a dev sign-in credential
 * from `dev-session.ts`) as the `?token=` Bearer credential — see `dev-auth.ts#extractBearerCredential`'s
 * doc comment for why a browser WebSocket upgrade must use the query-param form rather than an
 * `Authorization` header. Omitting `credential` reconnects anonymously (used for sign-out).
 *
 * Callers MUST force a remount of anything holding hook state derived from the old `runtime`
 * afterward (see header comment) — this function alone only affects code that reads the `runtime`
 * binding fresh from this point forward.
 */
export const switchWorkspaceConnection = (nextWorkspaceId: EntityId, credential?: string): void => {
  const previous = runtime
  runtime = buildRuntime(nextWorkspaceId, credential)
  runtimeConnectionIdentity = Object.freeze({})
  void previous.dispose()
}
