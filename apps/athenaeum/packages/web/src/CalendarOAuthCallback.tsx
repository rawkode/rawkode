import { useEffect, useState } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { GoogleCalendarOAuthCallbackInput, type DomainError } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId } from "./workspace-id.js"
import { saveCalendarBindingId } from "./calendar-binding-storage.js"
import { formatDomainError } from "./format-domain-error.js"

// The REAL other half of `CalendarPanel.tsx`'s OAuth redirect — this is genuinely what a
// production deployment's `CALENDAR_OAUTH_REDIRECT_URI` route does (see `gatekeeper-rpc.ts`'s own
// header comment on `GoogleCalendarOAuthCallbackInput`: "the client's own callback route... calls
// googleCalendarOAuthCallback"), not a dev-only artifact. Google would redirect the browser back
// to exactly this path (`/oauth/google-calendar/callback?code=...&state=...`) after the user
// grants (or denies) consent; this component reads those two query params and completes the
// exchange for real over the real RPC. `packages/web` has no router — this is a plain
// `window.location.pathname` check rendered unconditionally near the top of `Workspace`
// (App.tsx), same "no dependency needed for one route" reasoning `workspace-id.ts`'s own `?workspace=`
// query-param handling already uses. Vite's dev server serves `index.html` for this path too
// (default `appType: "spa"` history-fallback), so this works identically under `vite dev` and a
// real static-asset deployment.
//
// `calendarId`/`mode` are NOT sourced from a calendar picker (`gatekeeper-rpc.ts`'s own doc
// comment: "a client-side calendar picker... is out of scope for this schema-only stage" — still
// true here; no `listGoogleCalendars` RPC exists yet). Hardcoded to `"primary"`/`"allVisible"` —
// the single most useful default for a personal workspace's own primary Google Calendar. A future
// stage that adds a real picker should read these from `sessionStorage`/query params captured at
// `connectGoogleCalendar` time instead of literals here.
const CALLBACK_PATH = "/oauth/google-calendar/callback"
const DEFAULT_CALENDAR_ID = "primary"
const DEFAULT_MODE = "allVisible" as const

type CallbackState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "success"; readonly bindingId: string }
  | { readonly status: "failure"; readonly message: string }
  | { readonly status: "missing-params" }

/** Same `Effect.exit` + `Cause.squash` technique `use-effect-query.ts` uses, inlined here (this
 *  is a one-shot side effect triggered by a URL, not a `deps`-driven query — the hook doesn't
 *  fit) so a real `DomainError` (e.g. `ValidationError` for a `state` that doesn't match this
 *  workspace) renders via `formatDomainError` instead of a generic string, while a genuine defect
 *  (network failure, decode failure) still gets a readable fallback. */
const isDomainError = (value: unknown): value is DomainError =>
  typeof value === "object" && value !== null && typeof (value as { _tag?: unknown })._tag === "string"

export function CalendarOAuthCallback() {
  const [state, setState] = useState<CallbackState>({ status: "idle" })

  useEffect(() => {
    if (window.location.pathname !== CALLBACK_PATH) return

    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const oauthState = params.get("state")
    const errorParam = params.get("error") // Google sets this (e.g. "access_denied") on refusal.

    if (errorParam !== null) {
      setState({ status: "failure", message: `Google returned an OAuth error: "${errorParam}"` })
      return
    }
    if (code === null || oauthState === null) {
      setState({ status: "missing-params" })
      return
    }

    setState({ status: "running" })
    const effect = WorkspaceRpcClient.pipe(
      Effect.flatMap((client) =>
        client.googleCalendarOAuthCallback(
          new GoogleCalendarOAuthCallbackInput({
            workspaceId,
            code,
            state: oauthState,
            calendarId: DEFAULT_CALENDAR_ID,
            mode: DEFAULT_MODE
          })
        )
      )
    )
    const fiber = runtime.runFork(Effect.exit(effect))
    fiber.addObserver((outer) => {
      if (!Exit.isSuccess(outer)) return
      const inner = outer.value
      if (Exit.isSuccess(inner)) {
        saveCalendarBindingId(workspaceId, inner.value.binding.id)
        setState({ status: "success", bindingId: inner.value.binding.id })
      } else if (!Exit.isInterrupted(inner)) {
        const squashed: unknown = Cause.squash(inner.cause)
        setState({
          status: "failure",
          message: isDomainError(squashed)
            ? formatDomainError(squashed)
            : `Unexpected error — check the console for details (${String(squashed)})`
        })
        console.error(inner.cause.toString())
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const returnToApp = () => {
    window.history.replaceState(null, "", window.location.origin)
    window.location.assign("/")
  }

  if (window.location.pathname !== CALLBACK_PATH) return null

  return (
    <div className="oauth-callback-overlay">
      <div className="oauth-callback-card">
        <h2>Connecting Google Calendar…</h2>
        {state.status === "idle" && <p>Preparing…</p>}
        {state.status === "running" && <p>Completing the connection…</p>}
        {state.status === "missing-params" && (
          <p className="error">
            This page expects Google to redirect back with <code>?code=</code> and{" "}
            <code>?state=</code> query parameters, but at least one is missing. If you navigated
            here directly, go back and click "Connect Google Calendar" instead.
          </p>
        )}
        {state.status === "failure" && <p className="error">Couldn't complete the connection: {state.message}</p>}
        {state.status === "success" && (
          <p className="oauth-callback-success">
            Connected. Binding <code>{state.bindingId}</code> saved for this workspace, in this
            browser.
          </p>
        )}
        <button type="button" onClick={returnToApp}>
          Back to Athenaeum
        </button>
      </div>
    </div>
  )
}
